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
  type ContentFormat,
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

/**
 * Never let Markdown silently drop content: a note naming what it cannot
 * represent, to put in front of a Markdown rendering ("" when nothing is lost).
 */
function markdownNotice(json: any, exactVia: string): string {
  if (!json) return "";
  const findings = inspectContent(json);
  if (!isLossy(findings)) return "";
  return (
    `> Note: this page contains content Markdown cannot represent exactly ` +
    `(${describeFindings(findings)}). Use ${exactVia} for the exact content, ` +
    `and do not overwrite this page with Markdown.\n\n`
  );
}

/** JSON with object keys sorted, so key order never counts as a difference. */
function canonical(value: any): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
}

/**
 * Drop what Docmost treats as unset: null/undefined values, empty objects,
 * and dir="auto" on the doc node (the default direction). Docmost leaves
 * these out or fills them in depending on how content was written.
 */
function withoutUnset(value: any, isDoc = true): any {
  if (Array.isArray(value)) return value.map((v) => withoutUnset(v, false));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    if (isDoc && k === "attrs" && canonical(v) === canonical({ dir: "auto" })) continue;
    const cleaned = withoutUnset(v, false);
    if (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) continue;
    out[k] = cleaned;
  }
  return out;
}

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

  /**
   * One page of a cursor-paginated list endpoint, for tools whose results
   * can be long (history, trash, comments). Pass the returned nextCursor
   * back to get the next page.
   */
  async listOnePage(
    endpoint: string,
    payload: Record<string, unknown>,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: any[]; nextCursor: string | null }> {
    await this.ensureAuthenticated();
    const response = await this.client.post(endpoint, {
      ...payload,
      limit: Math.max(1, Math.min(100, limit)),
      ...(cursor ? { cursor } : {}),
    });
    const data = response.data?.data ?? response.data;
    const meta = data?.meta;
    return {
      items: data?.items || [],
      nextCursor: meta?.hasNextPage && meta?.nextCursor ? meta.nextCursor : null,
    };
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

  /** Direct children of a page, or the root pages of a space, in sidebar order. */
  async listChildPages(opts: { spaceId?: string; pageId?: string }) {
    if (!opts.spaceId && !opts.pageId) {
      throw new Error(
        "Pass pageId to list a page's children, or spaceId to list the pages at the root of a space.",
      );
    }
    const payload = opts.pageId ? { pageId: opts.pageId } : { spaceId: opts.spaceId };
    const pages = await this.paginateAll("/pages/sidebar-pages", payload);
    return pages.map((p: any) => ({ id: p.id, title: p.title, hasChildren: !!p.hasChildren }));
  }

  /** The page's ancestors from the space root down, ending with the page. */
  async getBreadcrumbs(pageId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/pages/breadcrumbs", { pageId });
    const crumbs: any[] = response.data?.data ?? [];
    return crumbs.map((p) => ({ id: p.id, title: p.title, spaceId: p.spaceId }));
  }

  async getSpace(spaceId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/spaces/info", { spaceId });
    const space = response.data?.data ?? {};
    return {
      ...filterSpace(space),
      ...(typeof space.memberCount === "number" ? { memberCount: space.memberCount } : {}),
    };
  }

  /** Docmost's saved versions of a page, newest first, one page of results. */
  async getPageHistory(pageId: string, cursor?: string, limit?: number) {
    const { items, nextCursor } = await this.listOnePage("/pages/history", { pageId }, cursor, limit);
    return {
      versions: items.map((h: any) => ({
        historyId: h.id,
        title: h.title,
        createdAt: h.createdAt,
        lastUpdatedBy: h.lastUpdatedBy?.name ?? null,
        contributors: (h.contributors || []).map((c: any) => c.name),
      })),
      nextCursor,
    };
  }

  /** One saved version, as Markdown (with the usual notice) or exact JSON. */
  async getPageVersion(historyId: string, format: "markdown" | "json" = "markdown") {
    await this.ensureAuthenticated();
    const response = await this.client.post("/pages/history/info", { historyId });
    const h = response.data?.data ?? {};
    const json = h.content ?? null;
    const content =
      format === "json"
        ? json
        : markdownNotice(json, 'get_page_version with format "json"') +
          (json ? convertProseMirrorToMarkdown(json).replace("{{SUBPAGES}}", "") : "");
    return {
      historyId: h.id,
      pageId: h.pageId,
      title: h.title,
      createdAt: h.createdAt,
      lastUpdatedBy: h.lastUpdatedBy?.name ?? null,
      content,
    };
  }

  /** Pages in a space's trash, one page of results. */
  async listTrash(spaceId: string, cursor?: string, limit?: number) {
    const { items, nextCursor } = await this.listOnePage("/pages/trash", { spaceId }, cursor, limit);
    return {
      pages: items.map((p: any) => ({
        id: p.id,
        title: p.title,
        parentPageId: p.parentPageId ?? null,
        deletedAt: p.deletedAt,
        deletedBy: p.deletedBy?.name ?? null,
      })),
      nextCursor,
    };
  }

  /**
   * Restore a page from the trash, with the pages under it. If its parent is
   * still in the trash, Docmost puts it at the space root instead.
   */
  async restorePage(pageId: string) {
    const page = await this.getPageForWrite(pageId);
    if (!page.deletedAt) {
      throw new Error(`Page ${pageId} is not in the trash, so there is nothing to restore.`);
    }
    const backupFile = await this.backupPage(page, "restore");
    const response = await this.client.post("/pages/restore", { pageId });
    const restored = response.data?.data ?? {};
    const detached = !!page.parentPageId && !restored.parentPageId;
    return {
      success: true,
      pageId,
      title: restored.title ?? page.title,
      parentPageId: restored.parentPageId ?? null,
      message:
        "Restored from the trash, with any pages under it." +
        (detached ? " Its parent is still in the trash, so it is now at the space root." : ""),
      backup: backupFile,
    };
  }

  /**
   * Move a page, with every page under it, to the root of another space.
   * Only the moved page is backed up: the pages under it keep their content
   * and their place beneath it.
   */
  async movePageToSpace(pageId: string, spaceId: string) {
    const page = await this.getPageForWrite(pageId);
    if (page.spaceId === spaceId) {
      throw new Error(`Page ${pageId} is already in space ${spaceId}; use move_page to move it within the space.`);
    }
    const backupFile = await this.backupPage(page, "move-to-space");
    await this.client.post("/pages/move-to-space", { pageId, spaceId });
    const after = await this.getPageRaw(pageId);
    if (after?.spaceId !== spaceId) {
      throw new Error(`Docmost accepted the move but page ${pageId} is still in space ${after?.spaceId}. Backup: ${backupFile}`);
    }
    return {
      success: true,
      pageId,
      message:
        "Moved to the root of the new space, with all pages under it. To undo, " +
        "move it back with move_page_to_space, then move_page to its old parent.",
      from: { spaceId: page.spaceId, parentPageId: page.parentPageId ?? null },
      to: { spaceId, parentPageId: null },
      backup: backupFile,
    };
  }

  /**
   * Copy a page and every page under it, in the same space ("Copy of ...",
   * placed after the original) or into another space (same title, at its
   * root). The original is not changed; it is backed up anyway, as before any
   * write.
   */
  async duplicatePage(pageId: string, spaceId?: string) {
    const { page, backupFile } = await this.snapshot(pageId, "duplicate");
    const response = await this.client.post("/pages/duplicate", {
      pageId,
      ...(spaceId ? { spaceId } : {}),
    });
    const copy = response.data?.data ?? {};
    const childPageIds: string[] = copy.childPageIds ?? [];
    return {
      success: true,
      sourcePageId: pageId,
      newPageId: copy.id,
      title: copy.title,
      spaceId: copy.spaceId ?? spaceId ?? page.spaceId,
      parentPageId: copy.parentPageId ?? null,
      copiedChildPages: childPageIds.length,
      message:
        `Copied the page${childPageIds.length ? ` and ${childPageIds.length} page(s) under it` : ""}. ` +
        "To undo, delete_page the copy (newPageId).",
      backup: backupFile,
    };
  }

  /** This server's own pre-write backups of a page, newest first. */
  async listPageBackups(pageId: string) {
    const entries = await backups.list(pageId);
    const out = [];
    for (const e of entries) {
      const name = e.file.split("/").pop()!;
      let title: string | null = null;
      try {
        title = (await backups.read(pageId, name)).title ?? null;
      } catch {
        // unreadable files are still listed, without a title
      }
      out.push({ backup: name, capturedAt: e.capturedAt, takenBefore: e.operation, title });
    }
    return {
      pageId,
      backups: out,
      note: "Each backup is the page as it was just before the operation named in takenBefore.",
    };
  }

  /**
   * Put a page's title and content back to one of its backups, writing the
   * exact JSON. The current state is backed up first, so this can be undone
   * by restoring that newer backup.
   */
  async restorePageBackup(pageId: string, backup: string, restoreTitle = true) {
    // Read the backup before taking the new one: saving prunes old backups,
    // and could otherwise remove the very file being restored.
    const snapshot = await backups.read(pageId, backup);
    const page = await this.getPageForWrite(pageId);
    if (page.deletedAt) {
      throw new Error(`Page ${pageId} is in the trash. restore_page it first, then restore the backup.`);
    }
    const backupFile = await this.backupPage(page, "pre-restore");

    const content = snapshot.content ?? { type: "doc", content: [] };
    const body: Record<string, unknown> = { pageId, content, format: "json", operation: "replace" };
    if (restoreTitle && snapshot.title) body.title = snapshot.title;
    await this.client.post("/pages/update", body);

    // Docmost stores the write asynchronously: wait until it shows up.
    let verified = "not confirmed";
    const deadline = Date.now() + HEADING_ID_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const stored = (await this.getPageRaw(pageId))?.content ?? null;
      if (canonical(stored) === canonical(content)) { verified = "exact"; break; }
      if (canonical(withoutUnset(stored)) === canonical(withoutUnset(content))) { verified = "equivalent"; break; }
      await sleep(400);
    }

    const moved =
      snapshot.spaceId !== page.spaceId || (snapshot.parentPageId ?? null) !== (page.parentPageId ?? null);
    return {
      success: true,
      pageId,
      restoredFrom: { backup, capturedAt: snapshot.capturedAt, takenBefore: snapshot.operation },
      titleRestored: !!body.title,
      verified,
      ...(verified === "equivalent"
        ? { note: "Content matches the backup apart from unset default attributes Docmost leaves out." }
        : {}),
      ...(verified === "not confirmed"
        ? { warning: "The restored content did not show up in time to confirm it; check the page with get_page format json." }
        : {}),
      ...(moved
        ? {
            location:
              `The page was in space ${snapshot.spaceId} under ${snapshot.parentPageId ?? "the root"} when backed up; ` +
              `it is now in ${page.spaceId} under ${page.parentPageId ?? "the root"}. Only title and content were restored; ` +
              "use move_page or move_page_to_space to move it back.",
          }
        : {}),
      backup: backupFile,
    };
  }

  /** A page's comments, oldest first, one page of results. */
  async getComments(pageId: string, cursor?: string, limit?: number) {
    const { items, nextCursor } = await this.listOnePage("/comments", { pageId }, cursor, limit);
    return {
      comments: items
        .filter((c: any) => !c.deletedAt)
        .map((c: any) => ({
          id: c.id,
          parentCommentId: c.parentCommentId ?? null,
          type: c.type ?? null,
          // The text the comment is anchored to (inline comments only).
          selection: c.selection ?? null,
          text: c.content ? convertProseMirrorToMarkdown(c.content).replace("{{SUBPAGES}}", "").trim() : "",
          author: c.creator?.name ?? null,
          createdAt: c.createdAt,
          editedAt: c.editedAt ?? null,
          resolved: !!c.resolvedAt,
          resolvedAt: c.resolvedAt ?? null,
          resolvedBy: c.resolvedBy?.name ?? null,
        })),
      nextCursor,
    };
  }

  /**
   * Reply in a comment's thread. Docmost only allows one level of replies,
   * so a reply to a reply goes to the thread's first comment.
   */
  async replyToComment(commentId: string, text: string) {
    if (!text.trim()) throw new Error("Nothing to post: the reply text is empty.");
    await this.ensureAuthenticated();
    const target = (await this.client.post("/comments/info", { commentId })).data?.data;
    if (!target?.pageId) throw new Error(`Comment ${commentId} was not found.`);
    let root = target;
    if (target.parentCommentId) {
      root = (await this.client.post("/comments/info", { commentId: target.parentCommentId })).data?.data;
    }
    const { backupFile } = await this.snapshot(target.pageId, "comment-reply");

    // Plain text: blank lines separate paragraphs, single newlines are breaks.
    const doc = {
      type: "doc",
      content: text.trim().split(/\n\s*\n/).map((para) => ({
        type: "paragraph",
        content: para.split("\n").flatMap((line, i) => [
          ...(i ? [{ type: "hardBreak" }] : []),
          ...(line ? [{ type: "text", text: line }] : []),
        ]),
      })),
    };
    const response = await this.client.post("/comments/create", {
      pageId: target.pageId,
      content: JSON.stringify(doc),
      parentCommentId: root.id,
      ...(root.type ? { type: root.type } : {}),
    });
    const created = response.data?.data ?? {};
    return {
      success: true,
      commentId: created.id,
      threadId: root.id,
      pageId: target.pageId,
      message:
        (root.id !== commentId ? "That comment is a reply, so this was posted to its thread. " : "") +
        "Posted as plain text. To remove it, delete it in Docmost.",
      backup: backupFile,
    };
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

  async getPage(pageId: string, format: "markdown" | "json" | "html" = "markdown") {
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

    if (format === "html") {
      let html = "";
      if (json) {
        try {
          const response = await this.client.post("/pages/info", { pageId, format: "html" });
          const c = response.data?.data?.content;
          html = typeof c === "string" ? c : "";
        } catch (err: any) {
          throw new Error(
            `Docmost could not render page ${pageId} as HTML (${err.message}); it fails on ` +
              `some blocks, such as footnotes. Use get_page with format "json" instead.`,
          );
        }
      }
      // A comment, not content: writing this HTML back must not add the note.
      const findings = json ? inspectContent(json, "html") : null;
      if (findings && isLossy(findings)) {
        html =
          `<!-- Note: this page contains content HTML cannot represent exactly ` +
          `(${describeFindings(findings).replace(/--/g, "- -")}). Use get_page with format "json" ` +
          `for the exact content, and do not overwrite this page with HTML. -->\n` + html;
      }
      return {
        data: filterPage(resultData, html, subpages),
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

    content = markdownNotice(json, 'get_page with format "json"') + content;

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
    format: ContentFormat = "markdown",
  ) {
    await this.ensureAuthenticated();

    const body: Record<string, unknown> = { spaceId, title };
    if (parentPageId) body.parentPageId = parentPageId;
    if (content.trim() !== "") {
      body.content = content;
      body.format = format;
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
      format?: ContentFormat;
    },
  ) {
    let { content } = options;
    const { title, force = false } = options;
    const operation = options.operation ?? "replace";
    const format = options.format ?? "markdown";
    const formatName = format === "html" ? "HTML" : "Markdown";

    // Empty or whitespace-only content means "not supplied" (title-only
    // rename), never "blank the page".
    if (content !== undefined && content.trim() === "") {
      content = undefined;
    }

    if (content === undefined && !title) {
      throw new Error("Nothing to update: provide content and/or title.");
    }

    const page = await this.getPageForWrite(pageId);

    // Refuse to replace content that this format cannot rebuild exactly.
    if (content !== undefined && operation === "replace" && !force) {
      const findings = inspectContent(page.content, format);
      if (isLossy(findings)) {
        throw new Error(
          `Refusing to replace page ${pageId}: it contains content that a ` +
            `${formatName} rewrite would lose or change: ${describeFindings(findings)}. ` +
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
      body.format = format;
      body.operation = operation;
    }
    await this.client.post("/pages/update", body);

    // A Markdown or HTML replace gives every heading a new id, which breaks links to
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
      'the exact ProseMirror content. format "html" (opt-in) gives Docmost\'s own ' +
      "HTML, which keeps tabs, columns, status, colours, alignment and comment " +
      "anchors that Markdown loses; it carries a note (as an HTML comment) when " +
      "even HTML cannot represent something.",
    inputSchema: {
      pageId: z.string(),
      format: z
        .enum(["markdown", "json", "html"])
        .optional()
        .describe('"markdown" (default), "json" for exact content, or "html"'),
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
      "Create a new page from Markdown (or HTML with format \"html\"), optionally under a parent page. The " +
      "title is set exactly as given. Reversible: delete_page moves it to the trash.",
    inputSchema: {
      title: z.string().describe("Title of the page"),
      content: z.string().describe("Content, in Markdown unless format is \"html\""),
      spaceId: z.string(),
      parentPageId: z
        .string()
        .optional()
        .describe("Optional parent page ID to nest under"),
      format: z
        .enum(["markdown", "html"])
        .optional()
        .describe('Format of content: "markdown" (default) or "html"'),
    },
  },
  async ({ title, content, spaceId, parentPageId, format }) => {
    const result = await docmostClient.createPage(
      title,
      content,
      spaceId,
      parentPageId,
      format ?? "markdown",
    );
    return jsonContent(result);
  },
);

// Tool: update_page
server.registerTool(
  "update_page",
  {
    description:
      "Update a page's title and/or content (Markdown, or HTML with format " +
      '"html", e.g. edited from get_page format "html"). A backup of the exact ' +
      "page is saved before every change. To rename only, pass title and omit " +
      'content. operation "replace" (default) rewrites the whole body and is ' +
      "refused if the page holds anything a rewrite in that format would lose (the " +
      "error names it); pass force=true only to accept that loss. " +
      '"append" and "prepend" add content without touching existing blocks.',
    inputSchema: {
      pageId: z.string().describe("ID of the page to update"),
      content: z
        .string()
        .optional()
        .describe(
          "New content in the given format. Omit (or leave empty) to change only the title.",
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
          "replace only: overwrite even though content the format cannot represent will be lost",
        ),
      format: z
        .enum(["markdown", "html"])
        .optional()
        .describe('Format of content: "markdown" (default) or "html"'),
    },
  },
  async ({ pageId, content, title, operation, force, format }) => {
    const result = await docmostClient.updatePage(pageId, {
      content,
      title,
      operation,
      force,
      format,
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

// Tool: list_child_pages
server.registerTool(
  "list_child_pages",
  {
    description:
      "List the direct children of a page (pass pageId), or the top-level pages " +
      "of a space (pass spaceId only), in sidebar order, with whether each has " +
      "children of its own. Read-only. Use it to walk the page tree; list_pages " +
      "is a flat recently-updated list instead.",
    inputSchema: {
      pageId: z.string().optional().describe("Parent page ID"),
      spaceId: z.string().optional().describe("Space ID, to list its root pages (ignored if pageId is set)"),
    },
  },
  async ({ pageId, spaceId }) => jsonContent(await docmostClient.listChildPages({ pageId, spaceId })),
);

// Tool: get_breadcrumbs
server.registerTool(
  "get_breadcrumbs",
  {
    description:
      "Get a page's location: its ancestors from the space root down, ending " +
      "with the page itself. Read-only.",
    inputSchema: { pageId: z.string() },
  },
  async ({ pageId }) => jsonContent(await docmostClient.getBreadcrumbs(pageId)),
);

// Tool: get_space
server.registerTool(
  "get_space",
  {
    description:
      "Get one space's details (name, slug, description, visibility, member " +
      "count). Read-only; does not list or change members.",
    inputSchema: { spaceId: z.string() },
  },
  async ({ spaceId }) => jsonContent(await docmostClient.getSpace(spaceId)),
);

// Pagination arguments shared by tools that return one page of a long list.
const pagingSchema = {
  cursor: z.string().optional().describe("nextCursor from the previous call, for the next page"),
  limit: z.number().int().min(1).max(100).optional().describe("Items per page (default 50)"),
};

// Tool: get_page_history
server.registerTool(
  "get_page_history",
  {
    description:
      "List the versions Docmost saved for a page, newest first (historyId, " +
      "title, time, who edited). Read-only. Docmost does not save a version for " +
      "every change, so this is not a reliable undo for MCP edits; use " +
      "list_page_backups for that. Returns nextCursor when there are more.",
    inputSchema: { pageId: z.string(), ...pagingSchema },
  },
  async ({ pageId, cursor, limit }) =>
    jsonContent(await docmostClient.getPageHistory(pageId, cursor, limit)),
);

// Tool: get_page_version
server.registerTool(
  "get_page_version",
  {
    description:
      "Get the content of one saved version from get_page_history. Read-only. " +
      'Markdown by default (with a note if it cannot represent everything), or format "json" for the exact content.',
    inputSchema: {
      historyId: z.string(),
      format: z.enum(["markdown", "json"]).optional().describe('"markdown" (default) or "json"'),
    },
  },
  async ({ historyId, format }) =>
    jsonContent(await docmostClient.getPageVersion(historyId, format ?? "markdown")),
);

// Tool: list_trash
server.registerTool(
  "list_trash",
  {
    description:
      "List the pages in a space's trash (id, title, when and by whom deleted). " +
      "Read-only. Returns nextCursor when there are more.",
    inputSchema: { spaceId: z.string(), ...pagingSchema },
  },
  async ({ spaceId, cursor, limit }) =>
    jsonContent(await docmostClient.listTrash(spaceId, cursor, limit)),
);

// Tool: restore_page
server.registerTool(
  "restore_page",
  {
    description:
      "Restore a page from the trash, together with the pages under it. If its " +
      "parent is still in the trash it goes to the space root. A backup is " +
      "saved first. Reversible: delete_page moves it back to the trash.",
    inputSchema: { pageId: z.string() },
  },
  async ({ pageId }) => jsonContent(await docmostClient.restorePage(pageId)),
);

// Tool: move_page_to_space
server.registerTool(
  "move_page_to_space",
  {
    description:
      "Move a page to another space. All pages under it move with it, and it " +
      "lands at the root of the target space. Content is unchanged, and links " +
      "and the page ID keep working. A backup is saved first, and the result " +
      "gives the old space and parent so it can be moved back (move_page_to_space, " +
      "then move_page). To copy instead, use duplicate_page with spaceId.",
    inputSchema: {
      pageId: z.string(),
      spaceId: z.string().describe("Target space ID"),
    },
  },
  async ({ pageId, spaceId }) => jsonContent(await docmostClient.movePageToSpace(pageId, spaceId)),
);

// Tool: duplicate_page
server.registerTool(
  "duplicate_page",
  {
    description:
      "Copy a page and all pages under it. Without spaceId the copy is titled " +
      '"Copy of ..." and placed right after the original; with spaceId it is ' +
      "copied into that space at its root with the same title. The original is " +
      "not changed. Returns newPageId. Reversible: delete_page the copy.",
    inputSchema: {
      pageId: z.string(),
      spaceId: z.string().optional().describe("Copy into this space instead of the same one"),
    },
  },
  async ({ pageId, spaceId }) => jsonContent(await docmostClient.duplicatePage(pageId, spaceId)),
);

// Tool: list_page_backups
server.registerTool(
  "list_page_backups",
  {
    description:
      "List this server's own backups of a page, newest first. One is saved " +
      "before every change made through these tools; each is the page as it " +
      "was just before the operation named in takenBefore. Read-only. Backups " +
      "expire after the configured age (default 90 days).",
    inputSchema: { pageId: z.string() },
  },
  async ({ pageId }) => jsonContent(await docmostClient.listPageBackups(pageId)),
);

// Tool: restore_page_backup
server.registerTool(
  "restore_page_backup",
  {
    description:
      "Put a page's content (exact JSON) and title back to one of its backups " +
      "from list_page_backups. The current state is backed up first, so this is " +
      "itself reversible. Does not move the page; if it has moved since, the " +
      "result says where it was. A page in the trash must be restore_page'd first.",
    inputSchema: {
      pageId: z.string(),
      backup: z.string().describe("Backup file name from list_page_backups"),
      restoreTitle: z.boolean().optional().describe("Also restore the title (default true)"),
    },
  },
  async ({ pageId, backup, restoreTitle }) =>
    jsonContent(await docmostClient.restorePageBackup(pageId, backup, restoreTitle ?? true)),
);

// Tool: get_comments
server.registerTool(
  "get_comments",
  {
    description:
      "List a page's comments, oldest first: text, author, times, whether " +
      "resolved, the thread it belongs to (parentCommentId), and for inline " +
      "comments the page text it is anchored to (selection). Read-only. Returns " +
      "nextCursor when there are more.",
    inputSchema: { pageId: z.string(), ...pagingSchema },
  },
  async ({ pageId, cursor, limit }) =>
    jsonContent(await docmostClient.getComments(pageId, cursor, limit)),
);

// Tool: reply_to_comment
server.registerTool(
  "reply_to_comment",
  {
    description:
      "Post a plain-text reply in a comment's thread (a reply to a reply goes " +
      "to that thread). Does not change the page; a page backup is saved anyway. " +
      "Cannot create new comments anchored to page text, and cannot resolve or " +
      "delete comments; do those in Docmost.",
    inputSchema: {
      commentId: z.string().describe("ID of the comment to reply to (from get_comments)"),
      text: z.string().describe("Reply text; blank lines separate paragraphs"),
    },
  },
  async ({ commentId, text }) => jsonContent(await docmostClient.replyToComment(commentId, text)),
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
