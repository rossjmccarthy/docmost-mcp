import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios, { AxiosInstance } from "axios";
import { z } from "zod";
import {
  filterWorkspace,
  filterSpace,
  filterGroup,
  filterPage,
  filterSearchResult,
} from "./lib/filters.js";
import { convertProseMirrorToMarkdown } from "./lib/markdown-converter.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { performLogin } from "./lib/auth-utils.js";
import { BackupStore } from "./lib/backup.js";
import {
  describeFindings,
  inspectContent,
  isLossy,
} from "./lib/content-guard.js";

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = packageJson.version;

const API_URL = process.env.DOCMOST_API_URL;
const EMAIL = process.env.DOCMOST_EMAIL;
const PASSWORD = process.env.DOCMOST_PASSWORD;

if (!API_URL || !EMAIL || !PASSWORD) {
  console.error(
    "Error: DOCMOST_API_URL, DOCMOST_EMAIL, and DOCMOST_PASSWORD environment variables are required.",
  );
  process.exit(1);
}

const positiveInt = (value: string | undefined, fallback: number) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const backups = new BackupStore(
  process.env.DOCMOST_BACKUP_DIR,
  positiveInt(process.env.DOCMOST_BACKUP_KEEP, 20),
  positiveInt(process.env.DOCMOST_BACKUP_MAX_AGE_DAYS, 90),
);

// Which converter get_page uses for Markdown: the fork's ProseMirror walker
// ("fork", default) or Docmost's own export ("native"). tests/roundtrip.mjs
// showed native drops underline, text colour and nested task items, so the
// fork's converter is the one the allow-list is proven against.
const MARKDOWN_READER =
  process.env.DOCMOST_MARKDOWN_READER === "native" ? "native" : "fork";

type ContentOperation = "replace" | "append" | "prepend";

// How long update_page waits for a Markdown replace to be stored before
// restoring heading ids.
const HEADING_ID_TIMEOUT_MS = positiveInt(process.env.DOCMOST_HEADING_ID_TIMEOUT_MS, 15000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Visit every node of a ProseMirror document, depth first, in order. */
function walkNodes(node: any, visit: (n: any) => unknown) {
  if (!node || typeof node !== "object") return;
  visit(node);
  if (Array.isArray(node.content)) node.content.forEach((c: any) => walkNodes(c, visit));
}

const nodeText = (node: any): string => {
  let text = "";
  walkNodes(node, (n) => {
    if (typeof n.text === "string") text += n.text;
  });
  return text;
};

class DocmostClient {
  // ... [Client Implementation stays exactly the same] ...
  private client: AxiosInstance;
  private token: string | null = null;

  constructor(baseURL: string) {
    this.client = axios.create({
      baseURL,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  async login() {
    if (!EMAIL || !PASSWORD) {
      throw new Error("Missing Credentials (DOCMOST_EMAIL, DOCMOST_PASSWORD)");
    }
    // baseURL is already set in this.client
    const baseURL = this.client.defaults.baseURL || "";

    // Use shared auth utility
    this.token = await performLogin(baseURL, EMAIL, PASSWORD);
    this.client.defaults.headers.common["Authorization"] =
      `Bearer ${this.token}`;
  }

  async ensureAuthenticated() {
    if (!this.token) {
      await this.login();
    }
  }

  /**
   * Generic pagination handler for Docmost API endpoints
   * @param endpoint - The API endpoint path (e.g., "/spaces", "/pages/recent")
   * @param basePayload - Base payload object to send with each request
   * @param limit - Items per page (min: 1, max: 100, default: 100)
   * @returns All items collected from all pages
   */
  async paginateAll<T = any>(
    endpoint: string,
    basePayload: Record<string, any> = {},
    limit: number = 100,
  ): Promise<T[]> {
    await this.ensureAuthenticated();

    // Clamp limit between 1 and 100
    const clampedLimit = Math.max(1, Math.min(100, limit));

    // Docmost 0.97 uses cursor pagination (meta.nextCursor). Stop when there
    // is no next cursor, and cap the page count so a server that ignores the
    // cursor cannot loop forever.
    const MAX_PAGES = 100;
    let allItems: T[] = [];
    let cursor: string | undefined;

    for (let i = 0; i < MAX_PAGES; i++) {
      const response = await this.client.post(endpoint, {
        ...basePayload,
        limit: clampedLimit,
        ...(cursor ? { cursor } : {}),
      });

      const data = response.data;

      // Handle both direct data.items and data.data.items structures
      const items = data.data?.items || data.items || [];
      const meta = data.data?.meta || data.meta;

      allItems = allItems.concat(items);
      if (!meta?.hasNextPage || !meta?.nextCursor || meta.nextCursor === cursor) {
        return allItems;
      }
      cursor = meta.nextCursor;
    }

    console.error(
      `paginateAll(${endpoint}): stopped after ${MAX_PAGES} pages; results may be incomplete`,
    );
    return allItems;
  }

  async getWorkspace() {
    await this.ensureAuthenticated();
    const response = await this.client.post("/workspace/info", {});
    return {
      data: filterWorkspace(response.data.data),
      success: response.data.success,
    };
  }

  async getSpaces() {
    const spaces = await this.paginateAll("/spaces", {});
    return spaces.map((space) => filterSpace(space));
  }

  async getGroups() {
    const groups = await this.paginateAll("/groups", {});
    return groups.map((group) => filterGroup(group));
  }

  async listPages(spaceId?: string) {
    const payload = spaceId ? { spaceId } : {};
    const pages = await this.paginateAll("/pages/recent", payload);
    return pages.map((page) => filterPage(page));
  }

  async listSidebarPages(spaceId: string, pageId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/pages/sidebar-pages", {
      spaceId,
      pageId,
    });
    return response.data?.data?.items || [];
  }

  /** Raw /pages/info response data, with content as ProseMirror JSON. */
  async getPageRaw(pageId: string): Promise<any> {
    await this.ensureAuthenticated();
    // Ask for JSON explicitly rather than relying on Docmost's default.
    const response = await this.client.post("/pages/info", {
      pageId,
      includeContent: true,
      format: "json",
    });
    return response.data.data;
  }

  /**
   * Fetch a page that is about to be changed. The guard and the backup both
   * depend on its exact content, so fail closed unless Docmost returned a
   * ProseMirror document. The one exception is a page that was never edited:
   * Docmost returns it with content present but null, which is an empty
   * document (and is backed up as null).
   */
  async getPageForWrite(pageId: string): Promise<any> {
    const page = await this.getPageRaw(pageId);
    if (
      page &&
      typeof page === "object" &&
      page.id === pageId &&
      typeof page.spaceId === "string" &&
      Object.hasOwn(page, "content") &&
      page.content === null
    ) {
      return { ...page, content: { type: "doc", content: [] }, storedContentWasNull: true };
    }
    const content = page?.content;
    if (
      !content ||
      typeof content !== "object" ||
      Array.isArray(content) ||
      content.type !== "doc"
    ) {
      throw new Error(
        `Refusing to modify page ${pageId}: Docmost did not return its content ` +
          `as a ProseMirror document, so it cannot be checked or backed up. ` +
          `Nothing was changed.`,
      );
    }
    return page;
  }

  async getPage(pageId: string, format: "markdown" | "json" = "markdown") {
    const resultData = await this.getPageRaw(pageId);
    const json = resultData.content ?? null;

    // Always fetch subpages to provide context to the agent
    let subpages: any[] = [];
    try {
      subpages = await this.listSidebarPages(resultData.spaceId, pageId);
    } catch (e: any) {
      console.error("Failed to fetch subpages:", e.message);
    }

    if (format === "json") {
      return {
        data: filterPage(resultData, json, subpages),
        success: true,
      };
    }

    let content = "";
    if (json) {
      content =
        MARKDOWN_READER === "fork"
          ? convertProseMirrorToMarkdown(json)
          : await this.getNativeMarkdown(pageId);
    }

    // Resolve subpages if the placeholder exists (fork converter only)
    if (content.includes("{{SUBPAGES}}")) {
      const list = subpages
        .map((p: any) => `- [${p.title}](page:${p.id})`)
        .join("\n");
      content = content.replace(
        "{{SUBPAGES}}",
        list ? `### Subpages\n${list}` : "",
      );
    }

    // Never let Markdown silently drop content: say what it cannot represent.
    const findings = json ? inspectContent(json) : null;
    if (findings && isLossy(findings)) {
      content =
        `> Note: this page contains content Markdown cannot represent exactly ` +
        `(${describeFindings(findings)}). Use get_page with format "json" for ` +
        `the exact content, and do not overwrite this page with Markdown.\n\n` +
        content;
    }

    return {
      data: filterPage(resultData, content, subpages),
      success: true,
    };
  }

  async getNativeMarkdown(pageId: string): Promise<string> {
    const response = await this.client.post("/pages/info", {
      pageId,
      format: "markdown",
    });
    const content = response.data.data?.content;
    return typeof content === "string" ? content : "";
  }

  /**
   * Save a pre-write snapshot of a page. Every mutation calls this first and
   * must not proceed if it throws.
   */
  async backupPage(page: any, operation: string): Promise<string> {
    try {
      return await backups.save({
        pageId: page.id,
        title: page.title ?? null,
        spaceId: page.spaceId,
        parentPageId: page.parentPageId ?? null,
        slugId: page.slugId,
        icon: page.icon ?? null,
        operation,
        capturedAt: new Date().toISOString(),
        content: page.storedContentWasNull ? null : page.content ?? null,
      });
    } catch (err: any) {
      throw new Error(
        `Aborted ${operation} of page ${page.id}: the pre-write backup could ` +
          `not be saved (${err.message}). Nothing was changed.`,
      );
    }
  }

  /** Fetch and back up a page before mutating it. */
  async snapshot(pageId: string, operation: string) {
    const page = await this.getPageForWrite(pageId);
    const backupFile = await this.backupPage(page, operation);
    return { page, backupFile };
  }

  /**
   * Create a page from Markdown with Docmost's native create endpoint, which
   * sets the title exactly and keeps a leading heading in the body.
   */
  async createPage(
    title: string,
    content: string,
    spaceId: string,
    parentPageId?: string,
  ) {
    await this.ensureAuthenticated();

    const body: Record<string, unknown> = { spaceId, title };
    if (parentPageId) body.parentPageId = parentPageId;
    if (content.trim() !== "") {
      body.content = content;
      body.format = "markdown";
    }

    const response = await this.client.post("/pages/create", body);
    return this.getPage(response.data.data.id);
  }

  /**
   * Update a page's title and/or content with Docmost's native update
   * endpoint. replace rewrites the whole body and is guarded; append and
   * prepend only add nodes. Every call is preceded by a backup.
   */
  async updatePage(
    pageId: string,
    options: {
      content?: string;
      title?: string;
      operation?: ContentOperation;
      force?: boolean;
    },
  ) {
    let { content } = options;
    const { title, force = false } = options;
    const operation = options.operation ?? "replace";

    // Empty or whitespace-only content means "not supplied" (title-only
    // rename), never "blank the page".
    if (content !== undefined && content.trim() === "") {
      content = undefined;
    }

    if (content === undefined && !title) {
      throw new Error("Nothing to update: provide content and/or title.");
    }

    const page = await this.getPageForWrite(pageId);

    // Refuse to replace content that Markdown cannot rebuild exactly.
    if (content !== undefined && operation === "replace" && !force) {
      const findings = inspectContent(page.content);
      if (isLossy(findings)) {
        throw new Error(
          `Refusing to replace page ${pageId}: it contains content that a ` +
            `Markdown rewrite would lose or change: ${describeFindings(findings)}. ` +
            `Use operation "append" or "prepend" to add content without touching ` +
            `what is there, edit the page in Docmost, or pass force=true to ` +
            `overwrite anyway (a backup is taken first).`,
        );
      }
    }

    const backupFile = await this.backupPage(
      page,
      content === undefined ? "rename" : operation,
    );

    const body: Record<string, unknown> = { pageId };
    if (title) body.title = title;
    if (content !== undefined) {
      body.content = content;
      body.format = "markdown";
      body.operation = operation;
    }
    await this.client.post("/pages/update", body);

    // A Markdown replace gives every heading a new id, which breaks links to
    // its anchor. Put back the old id wherever the heading text is unchanged.
    const headingIds =
      content !== undefined && operation === "replace"
        ? await this.restoreHeadingIds(pageId, page.content)
        : undefined;

    return {
      success: true,
      pageId,
      operation: content === undefined ? "rename" : operation,
      message:
        content === undefined
          ? "Page title updated."
          : `Page content ${operation === "replace" ? "replaced" : operation + "ed"}.`,
      // The content change succeeded either way; a failed id restore is a
      // warning, never an error.
      ...(headingIds ? { headingIds } : {}),
      ...(headingIds?.warning ? { warning: headingIds.warning } : {}),
      backup: backupFile,
    };
  }

  /** Read stored content until it differs from `before` and is stable. */
  async waitForStoredChange(pageId: string, before: string, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const first = JSON.stringify((await this.getPageRaw(pageId))?.content ?? null);
      if (first !== before) {
        await sleep(500);
        const second = (await this.getPageRaw(pageId))?.content ?? null;
        if (JSON.stringify(second) === first) return second;
      } else {
        await sleep(300);
      }
    }
    return undefined;
  }

  /**
   * After a Markdown replace, give each heading whose text is unchanged its
   * previous id again (repeated texts pair up in order), with one JSON write
   * that changes nothing but ids. Never throws: the replace itself has
   * already succeeded, so problems are reported in the result.
   */
  async restoreHeadingIds(pageId: string, before: any) {
    const oldIds = new Map<string, string[]>();
    let withIds = 0;
    walkNodes(before, (n) => {
      if (n.type === "heading" && typeof n.attrs?.id === "string" && n.attrs.id) {
        const text = nodeText(n);
        oldIds.set(text, [...(oldIds.get(text) || []), n.attrs.id]);
        withIds++;
      }
    });
    if (!withIds) return undefined;

    try {
      const after = await this.waitForStoredChange(pageId, JSON.stringify(before), HEADING_ID_TIMEOUT_MS);
      if (!after || after.type !== "doc") {
        return { kept: 0, of: withIds, warning: "The new content did not appear in time, so heading ids were not restored; links to headings on this page may break." };
      }
      // Docmost does not de-duplicate ids, so never reuse one already present.
      const present = new Set<string>();
      walkNodes(after, (n) => typeof n.attrs?.id === "string" && present.add(n.attrs.id));
      const patched = structuredClone(after);
      let kept = 0;
      walkNodes(patched, (n) => {
        if (n.type !== "heading") return;
        const queue = oldIds.get(nodeText(n));
        const id = queue?.shift();
        if (!id) return;
        if (n.attrs?.id === id) { kept++; return; }
        if (present.has(id)) return;
        n.attrs = { ...n.attrs, id };
        present.add(id);
        kept++;
      });
      if (JSON.stringify(patched) !== JSON.stringify(after)) {
        await this.client.post("/pages/update", { pageId, content: patched, format: "json", operation: "replace" });
      }
      return {
        kept,
        of: withIds,
        ...(kept < withIds ? { note: `${withIds - kept} heading(s) changed text or were removed, so their anchors changed.` } : {}),
      };
    } catch (err: any) {
      return { kept: 0, of: withIds, warning: `Heading ids were not restored (${err.message}); links to headings on this page may break.` };
    }
  }

  async search(
    query: string,
    options: {
      spaceId?: string;
      titleOnly?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/search", { query, ...options });

    // Docmost 0.80 returned data as an array; 0.97 wraps it in data.items
    const data = response.data?.data;
    const items = Array.isArray(data) ? data : data?.items || [];
    const filteredItems = items.map((item: any) => filterSearchResult(item));

    return {
      items: filteredItems,
      success: response.data?.success || false,
    };
  }

  async movePage(
    pageId: string,
    parentPageId: string | null,
    position?: string,
  ) {
    const { backupFile } = await this.snapshot(pageId, "move");
    // Docmost requires position >= 5 chars.
    const validPosition = position || "a00000";

    const result = await this.client
      .post("/pages/move", {
        pageId,
        parentPageId,
        position: validPosition,
      })
      .then((res) => res.data);
    return { ...result, backup: backupFile };
  }

  /** Move a page to the trash (soft delete; restorable in Docmost). */
  async deletePage(pageId: string) {
    const { backupFile } = await this.snapshot(pageId, "delete");
    await this.client.post("/pages/delete", { pageId });
    return { backup: backupFile };
  }

  async deletePages(pageIds: string[]) {
    // Sequential so each page is backed up before it is trashed.
    const results = [];
    for (const id of pageIds) {
      try {
        const { backup } = await this.deletePage(id);
        results.push({ id, success: true, backup });
      } catch (err: any) {
        results.push({ id, success: false, error: err.message });
      }
    }
    return results;
  }
}

const docmostClient = new DocmostClient(API_URL);

// --- Modern McpServer Implementation ---

const server = new McpServer({
  name: "docmost-mcp",
  version: VERSION,
});

// Helper to format JSON responses
const jsonContent = (data: any) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

// Tool: list_workspaces
server.registerTool(
  "get_workspace",
  {
    description: "Get the current Docmost workspace",
  },
  async () => {
    const workspace = await docmostClient.getWorkspace();
    return jsonContent(workspace);
  },
);

// Tool: list_spaces
server.registerTool(
  "list_spaces",
  {
    description: "List all available spaces in Docmost",
  },
  async () => {
    const spaces = await docmostClient.getSpaces();
    return jsonContent(spaces);
  },
);

// Tool: list_groups
server.registerTool(
  "list_groups",
  {
    description: "List all available groups in Docmost",
  },
  async () => {
    const groups = await docmostClient.getGroups();
    return jsonContent(groups);
  },
);

// Tool: list_pages
server.registerTool(
  "list_pages",
  {
    description: "List pages in a space ordered by updatedAt (descending).",
    inputSchema: {
      spaceId: z.string().optional(),
    },
  },
  async ({ spaceId }) => {
    const result = await docmostClient.listPages(spaceId);
    return jsonContent(result);
  },
);

// Tool: get_page
server.registerTool(
  "get_page",
  {
    description:
      "Get a page's details and content. Read-only. Markdown (the default) is " +
      "convenient but cannot represent every Docmost block; when it cannot, the " +
      "content starts with a note naming what is missing. Use format \"json\" for " +
      "the exact ProseMirror content.",
    inputSchema: {
      pageId: z.string(),
      format: z
        .enum(["markdown", "json"])
        .optional()
        .describe('"markdown" (default) or "json" for exact content'),
    },
  },
  async ({ pageId, format }) => {
    const page = await docmostClient.getPage(pageId, format ?? "markdown");
    return jsonContent(page);
  },
);

// Tool: create_page
server.registerTool(
  "create_page",
  {
    description:
      "Create a new page from Markdown, optionally under a parent page. The " +
      "title is set exactly as given. Reversible: delete_page moves it to the trash.",
    inputSchema: {
      title: z.string().describe("Title of the page"),
      content: z.string().describe("Markdown content"),
      spaceId: z.string(),
      parentPageId: z
        .string()
        .optional()
        .describe("Optional parent page ID to nest under"),
    },
  },
  async ({ title, content, spaceId, parentPageId }) => {
    const result = await docmostClient.createPage(
      title,
      content,
      spaceId,
      parentPageId,
    );
    return jsonContent(result);
  },
);

// Tool: update_page
server.registerTool(
  "update_page",
  {
    description:
      "Update a page's title and/or Markdown content. A backup of the exact " +
      "page is saved before every change. To rename only, pass title and omit " +
      'content. operation "replace" (default) rewrites the whole body and is ' +
      "refused if the page holds anything a Markdown rewrite would lose (the " +
      "error names it); pass force=true only to accept that loss. " +
      '"append" and "prepend" add content without touching existing blocks.',
    inputSchema: {
      pageId: z.string().describe("ID of the page to update"),
      content: z
        .string()
        .optional()
        .describe(
          "Markdown content. Omit (or leave empty) to change only the title.",
        ),
      title: z.string().optional().describe("Optional new title"),
      operation: z
        .enum(["replace", "append", "prepend"])
        .optional()
        .describe(
          '"replace" (default) the whole body, or "append"/"prepend" the content',
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "replace only: overwrite even though content Markdown cannot represent will be lost",
        ),
    },
  },
  async ({ pageId, content, title, operation, force }) => {
    const result = await docmostClient.updatePage(pageId, {
      content,
      title,
      operation,
      force,
    });
    return jsonContent(result);
  },
);

// Tool: move_page
server.registerTool(
  "move_page",
  {
    description:
      "Move a page to a new parent within its space, or to the space root. " +
      "A backup is saved first. Reversible by moving it back.",
    inputSchema: {
      pageId: z.string(),
      parentPageId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Target parent page ID. Pass 'null' or empty string to move to root.",
        ),
      position: z
        .string()
        .optional()
        .describe(
          "Optional position string (5-12 chars). Defaults to 'a00000' (end) if omitted.",
        ),
    },
  },
  async ({ pageId, parentPageId, position }) => {
    // Ensure parentPageId is null if string "null" or empty is passed, or undefined
    // Note: Zod handles type checking, but we double check for empty strings just in case
    const finalParentId =
      parentPageId === "" || parentPageId === "null" ? null : parentPageId;

    const result = await docmostClient.movePage(
      pageId,
      finalParentId || null,
      position,
    );
    return {
      content: [
        {
          type: "text",
          text: `Moved page ${pageId} to parent ${finalParentId || "root"}. Backup: ${result.backup}`,
        },
      ],
    };
  },
);

// Tool: delete_page
server.registerTool(
  "delete_page",
  {
    description:
      "Move a page to the Docmost trash (restorable from Docmost). A backup is " +
      "saved first. Never deletes permanently.",
    inputSchema: {
      pageId: z.string(),
    },
  },
  async ({ pageId }) => {
    const result = await docmostClient.deletePage(pageId);
    return {
      content: [
        {
          type: "text",
          text: `Moved page ${pageId} to the trash. Backup: ${result.backup}`,
        },
      ],
    };
  },
);

// Tool: delete_pages
server.registerTool(
  "delete_pages",
  {
    description:
      "Move several pages to the Docmost trash, one at a time, backing up each " +
      "first. A page whose backup fails is skipped. Never deletes permanently.",
    inputSchema: {
      pageIds: z.array(z.string()),
    },
  },
  async ({ pageIds }) => {
    const results = await docmostClient.deletePages(pageIds);
    return jsonContent(results);
  },
);

// Tool: search
server.registerTool(
  "search",
  {
    description: "Search for pages and content. Read-only.",
    inputSchema: {
      query: z.string().describe("Search query"),
      spaceId: z.string().optional().describe("Optional space ID to filter by"),
      titleOnly: z
        .boolean()
        .optional()
        .describe("Match page titles only, not page content"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum results to return (Docmost default 25)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of results to skip, for paging"),
    },
  },
  async ({ query, spaceId, titleOnly, limit, offset }) => {
    const result = await docmostClient.search(query, {
      spaceId,
      titleOnly,
      limit,
      offset,
    });
    return jsonContent(result);
  },
);

async function run() {
  // Expire old backups, including those of pages never written again.
  try {
    const swept = await backups.sweep();
    if (swept.pages) {
      console.error(
        `Backup sweep: ${swept.pages} page folders checked, ${swept.removed} ` +
          `expired files removed, ${swept.emptied} empty folders removed`,
      );
    }
  } catch (err: any) {
    console.error(`Backup sweep failed: ${err.message}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
