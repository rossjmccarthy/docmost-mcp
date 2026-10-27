// Acceptance checks from the Phase 1 brief, run against a live Docmost through
// the MCP tools. Creates only "MCPTEST ..." pages in the test space and
// permanently deletes them at the end.
//
// Usage: npm run test:acceptance
import { mkdtemp, readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  TEST_SPACE_ID, PREFIX, apiClient, mcpServer, cleanupOnInterrupt, waitForContent,
  settledWrite, normalize, sleep,
} from "./lib.mjs";
import { fixtures } from "./fixtures.mjs";

const api = await apiClient();
const backupDir = await mkdtemp(join(tmpdir(), "mcptest-acceptance-"));
const tool = mcpServer({ DOCMOST_BACKUP_DIR: backupDir });
const created = [];
cleanupOnInterrupt(api, created);
const checks = [];

const check = (name, pass, detail = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
};
const fixture = (name) => fixtures.find(([n]) => n === name)[1];
const backupsFor = async (pageId) => {
  try {
    return (await readdir(join(backupDir, pageId))).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
};
const settle = async (pageId, before) =>
  waitForContent(api, pageId, (c) => JSON.stringify(c) !== JSON.stringify(before));

// Create a test page and return it after one pass through Docmost's JSON
// write path, so later reads compare like with like (defaults filled in).
async function apiPage(name, content) {
  const page = await api.post("/pages/create", {
    spaceId: TEST_SPACE_ID, title: `${PREFIX} ${name}`, content, format: "json",
  });
  created.push(page.id);
  const stored = await settledWrite(api, page.id, () =>
    api.post("/pages/update", { pageId: page.id, content, format: "json", operation: "replace" }));
  return { id: page.id, content: stored };
}

try {
  // Tool names must match the MCP hub's pattern.
  const tools = await tool.listTools();
  const bad = tools.filter((t) => !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name));
  check("tool names match ^[a-zA-Z0-9_-]{1,64}$", bad.length === 0, bad.map((t) => t.name).join(", "));

  // Search. Instance-specific: set MCPTEST_SEARCH_QUERY and the title it
  // must find in MCPTEST_SEARCH_EXPECT.
  const query = process.env.MCPTEST_SEARCH_QUERY;
  if (query) {
    const s = await tool.call("search", { query });
    const titles = (s.json?.items || []).map((i) => i.title);
    check(`search '${query}' finds the expected page`, titles.includes(process.env.MCPTEST_SEARCH_EXPECT), titles.slice(0, 3).join(" | "));
  }
  const s2 = await tool.call("search", { query: query || "the", titleOnly: true, limit: 2 });
  check("search accepts titleOnly and limit", s2.ok && (s2.json?.items || []).length <= 2, s2.ok ? "" : s2.text);

  // Pagination terminates; point MCPTEST_LIST_SPACE_ID at a space with >100 pages.
  const lp = await tool.call("list_pages", { spaceId: process.env.MCPTEST_LIST_SPACE_ID || TEST_SPACE_ID });
  const ids = (lp.json || []).map((p) => p.id);
  check("list_pages returns distinct pages and terminates", lp.ok && ids.length > 0 && new Set(ids).size === ids.length, `${ids.length} pages`);

  // F2: native create keeps a leading heading and an exact title.
  const title = `${PREFIX} Sláinte's Fréjus (trip) & co - notes [v2]`;
  const c = await tool.call("create_page", { title, content: "## Something\n\nBody text.", spaceId: TEST_SPACE_ID });
  const newId = c.json?.data?.id;
  if (newId) created.push(newId);
  const info = newId ? await api.post("/pages/info", { pageId: newId }) : null;
  check("create_page sets the exact title", info?.title === title, info?.title);
  const first = info?.content?.content?.[0];
  check("create_page keeps a leading ## heading", first?.type === "heading" && first?.attrs?.level === 2 && first?.content?.[0]?.text === "Something", JSON.stringify(first)?.slice(0, 80));

  // Title-only rename takes a backup and leaves content alone.
  const renamed = `${title} (renamed)`;
  const before = info.content;
  const r = await tool.call("update_page", { pageId: newId, title: renamed, content: "  " });
  await sleep(1000);
  const afterRename = await api.post("/pages/info", { pageId: newId });
  check("title-only rename keeps content and title is exact", r.ok && afterRename.title === renamed && JSON.stringify(afterRename.content) === JSON.stringify(before), r.ok ? "" : r.text);
  check("rename took a backup", (await backupsFor(newId)).length === 1);

  // A page created without content is stored as content: null; it is still
  // an ordinary page that can be renamed (and the backup records null).
  const empty = await tool.call("create_page", { title: `${PREFIX} empty page`, content: "", spaceId: TEST_SPACE_ID });
  const emptyId = empty.json?.data?.id;
  if (emptyId) created.push(emptyId);
  const emptyInfo = emptyId ? await api.post("/pages/info", { pageId: emptyId }) : null;
  const emptyRename = emptyId ? await tool.call("update_page", { pageId: emptyId, title: `${PREFIX} empty page (renamed)` }) : null;
  const emptyBackups = emptyId ? await backupsFor(emptyId) : [];
  const emptySaved = emptyBackups.length === 1
    ? JSON.parse(await readFile(join(backupDir, emptyId, emptyBackups[0]), "utf-8"))
    : null;
  check("empty page (content null) can be renamed, backup records null",
    emptyInfo?.content === null && emptyRename?.ok && emptySaved?.content === null,
    `content ${JSON.stringify(emptyInfo?.content)}; ${emptyRename?.text.slice(0, 90)}`);

  // F3: Markdown replace refused on pages with content Markdown cannot rebuild.
  for (const name of ["tabs", "columns", "status", "page-break", "embed", "mark-comment", "mixed-marks", "details-open", "attr-text-align"]) {
    const page = await apiPage(`guard ${name}`, fixture(name));
    const res = await tool.call("update_page", { pageId: page.id, content: "replacement", operation: "replace" });
    const after = (await api.post("/pages/info", { pageId: page.id })).content;
    check(`replace refused without force: ${name}`, !res.ok && /Refusing to replace/.test(res.text) && JSON.stringify(after) === JSON.stringify(page.content), res.text.slice(0, 140));
  }

  // append / prepend never alter existing nodes (and skip the guard).
  const mixed = { type: "doc", content: [...fixture("tabs").content, ...fixture("columns").content, ...fixture("status").content] };
  const ap = await apiPage("append", mixed);
  const orig = normalize(ap.content).doc.content;
  const a1 = await tool.call("update_page", { pageId: ap.id, content: "Appended paragraph.", operation: "append" });
  const afterAppend = await settle(ap.id, ap.content);
  const na = normalize(afterAppend).doc.content;
  check("append works without force", a1.ok, a1.ok ? "" : a1.text);
  check("append leaves existing nodes untouched", JSON.stringify(na.slice(0, orig.length)) === JSON.stringify(orig) && na.length === orig.length + 1);
  const p1 = await tool.call("update_page", { pageId: ap.id, content: "Prepended paragraph.", operation: "prepend" });
  const afterPrepend = await settle(ap.id, afterAppend);
  const np = normalize(afterPrepend).doc.content;
  check("prepend works and leaves existing nodes untouched", p1.ok && JSON.stringify(np.slice(1)) === JSON.stringify(na));
  const apBackups = await backupsFor(ap.id);
  check("append and prepend each took a backup", apBackups.length === 2, apBackups.join(", "));
  const firstBackup = JSON.parse(await readFile(join(backupDir, ap.id, apBackups.sort()[0]), "utf-8"));
  check("backup holds the exact pre-write JSON", JSON.stringify(firstBackup.content) === JSON.stringify(ap.content) && firstBackup.spaceId === TEST_SPACE_ID);

  // Forced replace still backs up first.
  const fr = await tool.call("update_page", { pageId: ap.id, content: "Forced.", operation: "replace", force: true });
  await settle(ap.id, afterPrepend);
  check("forced replace succeeds and took a backup", fr.ok && (await backupsFor(ap.id)).length === 3, fr.ok ? "" : fr.text);

  // F4: get_page is honest.
  const gp = await apiPage("get-page", fixture("status"));
  const md = await tool.call("get_page", { pageId: gp.id });
  check("get_page markdown flags unrepresentable content", md.ok && md.json.data.content.startsWith("> Note:") && /status/.test(md.json.data.content), md.json?.data?.content?.slice(0, 120));
  const js = await tool.call("get_page", { pageId: gp.id, format: "json" });
  check("get_page json returns exact content", js.ok && JSON.stringify(js.json.data.content) === JSON.stringify(gp.content));

  // move and delete back up first; delete goes to trash.
  const mv = await tool.call("move_page", { pageId: gp.id, parentPageId: ap.id });
  check("move_page took a backup", mv.ok && (await backupsFor(gp.id)).length === 1, mv.ok ? "" : mv.text);
  const del = await tool.call("delete_page", { pageId: gp.id });
  const trash = await api.post("/pages/trash", { spaceId: TEST_SPACE_ID });
  check("delete_page backs up and moves to trash", del.ok && (await backupsFor(gp.id)).length === 2 && (trash.items || []).some((p) => p.id === gp.id), del.ok ? "" : del.text);

  // Without a backup directory, mutations refuse.
  const noBackup = mcpServer({ DOCMOST_BACKUP_DIR: "" });
  const nb = await noBackup.call("update_page", { pageId: ap.id, title: "should not apply" });
  const stillTitle = (await api.post("/pages/info", { pageId: ap.id })).title;
  check("mutations refuse when backups are not configured", !nb.ok && /backup/i.test(nb.text) && stillTitle !== "should not apply", nb.text.slice(0, 120));
  noBackup.close();
  check("stdout carries protocol only", tool.strayStdout.length === 0 && noBackup.strayStdout.length === 0, tool.strayStdout[0] || noBackup.strayStdout[0]);
} finally {
  for (const id of created) {
    // A child already went with its parent when that was deleted first.
    await api.post("/pages/delete", { pageId: id, permanentlyDelete: true }).catch((e) => {
      if (!/not found/i.test(e.message)) console.log(`cleanup failed for ${id}: ${e.message}`);
    });
  }
  const trash = await api.post("/pages/trash", { spaceId: TEST_SPACE_ID });
  const left = (trash.items || []).filter((p) => p.title?.startsWith(PREFIX));
  check("no MCPTEST pages left in the test space trash", left.length === 0, left.map((p) => p.title).join(", "));
  tool.close();
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
