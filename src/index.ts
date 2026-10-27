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

// Docmost node types the Markdown -> ProseMirror writer has no extension for.
const UNREBUILDABLE_NODE_TYPES = new Set([
  "callout",
  "details",
  "mention",
  "attachment",
  "drawio",
  "excalidraw",
  "embed",
  "video",
  "youtube",
  "mathInline",
  "mathBlock",
  "subpages",
]);

type ContentOperation = "replace" | "append" | "prepend";

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

  async getPage(pageId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/pages/info", { pageId });
    const resultData = response.data.data; // Assuming data is nested under 'data'

    let content = resultData.content
      ? convertProseMirrorToMarkdown(resultData.content)
      : ""; // Default to empty string

    // Always fetch subpages to provide context to the agent
    let subpages: any[] = [];

    try {
      subpages = await this.listSidebarPages(resultData.spaceId, pageId);
    } catch (e: any) {
      console.warn("Failed to fetch subpages:", e);
    }

    // Resolve subpages if the placeholder exists
    if (content && content.includes("{{SUBPAGES}}")) {
      if (subpages && subpages.length > 0) {
        const list = subpages
          .map((p: any) => `- [${p.title}](page:${p.id})`)
          .join("\n");
        content = content.replace("{{SUBPAGES}}", `### Subpages\n${list}`);
      } else {
        content = content.replace("{{SUBPAGES}}", "");
      }
    }

    return {
      data: filterPage(resultData, content, subpages),
      success: response.data.success,
    };
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
   * Return the node types in a page's current ProseMirror JSON that the
   * Markdown writer cannot rebuild, so overwriting would silently lose them.
   */
  async findUnrebuildableNodes(pageId: string): Promise<string[]> {
    const response = await this.client.post("/pages/info", { pageId });
    const found = new Set<string>();
    const walk = (node: any) => {
      if (!node) return;
      if (UNREBUILDABLE_NODE_TYPES.has(node.type)) found.add(node.type);
      (node.content || []).forEach(walk);
    };
    walk(response.data.data?.content);
    return [...found].sort();
  }

  /**
   * Update a page's title and/or content with Docmost's native update
   * endpoint. replace rewrites the whole body and is guarded; append and
   * prepend only add nodes.
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
    await this.ensureAuthenticated();

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

    // Refuse to replace content the writer cannot rebuild (before any write)
    if (content !== undefined && operation === "replace" && !force) {
      const unsupported = await this.findUnrebuildableNodes(pageId);
      if (unsupported.length > 0) {
        throw new Error(
          `Refusing to overwrite page ${pageId}: it contains node types that ` +
            `cannot be rebuilt from Markdown and would be lost: ` +
            `${unsupported.join(", ")}. Edit this page in Docmost, or pass ` +
            `force=true to overwrite anyway.`,
        );
      }
    }

    const body: Record<string, unknown> = { pageId };
    if (title) body.title = title;
    if (content !== undefined) {
      body.content = content;
      body.format = "markdown";
      body.operation = operation;
    }
    await this.client.post("/pages/update", body);

    return {
      success: true,
      pageId,
      operation: content === undefined ? "rename" : operation,
      message:
        content === undefined
          ? "Page title updated."
          : `Page content ${operation === "replace" ? "replaced" : operation + "ed"}.`,
    };
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
    await this.ensureAuthenticated();
    // Docmost requires position >= 5 chars.
    const validPosition = position || "a00000";

    return this.client
      .post("/pages/move", {
        pageId,
        parentPageId,
        position: validPosition,
      })
      .then((res) => res.data);
  }

  async deletePage(pageId: string) {
    await this.ensureAuthenticated();
    return this.client
      .post("/pages/delete", { pageId })
      .then((res) => res.data);
  }

  async deletePages(pageIds: string[]) {
    await this.ensureAuthenticated();
    const promises = pageIds.map((id) =>
      this.client
        .post("/pages/delete", { pageId: id })
        .then(() => ({ id, success: true }))
        .catch((err: any) => ({ id, success: false, error: err.message })),
    );
    return Promise.all(promises);
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
    description: "Get details and content of a specific page by ID",
    inputSchema: {
      pageId: z.string(),
    },
  },
  async ({ pageId }) => {
    const page = await docmostClient.getPage(pageId);
    return jsonContent(page);
  },
);

// Tool: create_page
server.registerTool(
  "create_page",
  {
    description:
      "Create a new page from Markdown, optionally under a parent page. The " +
      "title is set exactly as given.",
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
      "Update a page's title and/or Markdown content. To rename only, pass " +
      'title and omit content. operation "replace" (default) rewrites the whole ' +
      "body and is refused if the page contains blocks Markdown cannot rebuild " +
      "(the error names them) unless force=true, which discards them. " +
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
          "replace only: overwrite even though blocks Markdown cannot rebuild will be lost",
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
      "Move a page to a new parent within its space, or to the space root.",
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

    await docmostClient.movePage(pageId, finalParentId || null, position);
    return {
      content: [
        {
          type: "text",
          text: `Successfully moved page ${pageId} to parent ${finalParentId || "root"}`,
        },
      ],
    };
  },
);

// Tool: delete_page
server.registerTool(
  "delete_page",
  {
    description: "Delete a single page by ID.",
    inputSchema: {
      pageId: z.string(),
    },
  },
  async ({ pageId }) => {
    await docmostClient.deletePage(pageId);
    return {
      content: [{ type: "text", text: `Successfully deleted page ${pageId}` }],
    };
  },
);

// Tool: delete_pages
server.registerTool(
  "delete_pages",
  {
    description: "Delete multiple pages at once. Useful for cleanup.",
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
