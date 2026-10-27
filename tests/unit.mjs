// Offline checks (no Docmost needed): the guard's verdict on every fixture,
// and tool names valid for MCP hubs. Run with: npm test
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "path";
import { ROOT, mcpServer } from "./lib.mjs";
import { fixtures } from "./fixtures.mjs";

const { inspectContent, isLossy } = await import(join(ROOT, "build/lib/content-guard.js"));
const { BackupStore } = await import(join(ROOT, "build/lib/backup.js"));

// Fixtures the round-trip harness proved exact with the fork converter and
// Docmost's native Markdown writer. Everything else must be blocked.
const ALLOWED = new Set([
  "headings", "leading-h2", "marks-basic", "mark-link", "mark-underline", "mark-sub-sup",
  "bullet-list", "ordered-list", "ordered-list-start-3", "nested-lists", "task-list", "table",
  "code-block", "blockquote", "horizontal-rule", "hard-break", "unicode-text",
  "special-characters", "line-start-markers", "bare-urls-and-emails", "inline-code-backticks",
  "code-block-fence", "blockquote-multi", "mark-link-internal", "mark-link-special-href",
  "callout-info", "mark-highlight", "mark-text-colour", "image", "image-sized", "callout", "details",
]);

const canonicalJson = (v) =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

let failures = 0;
let checks = 0;
const check = async (name, fn) => {
  checks++;
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
};

for (const [name, doc] of fixtures) {
  await check(`guard: ${name}`, () =>
    assert.equal(!isLossy(inspectContent(doc)), ALLOWED.has(name),
      ALLOWED.has(name) ? "proven exact but blocked" : "lossy but allowed"));
}
for (const name of ALLOWED) {
  await check(`fixture exists: ${name}`, () => assert.ok(fixtures.some(([n]) => n === name)));
}

// Docmost's Markdown create puts dir="auto" on the doc node; that must not
// block a later replace (create_page followed by update_page).
await check("guard allows doc.dir=auto from a Markdown create", () =>
  assert.equal(isLossy(inspectContent({ type: "doc", attrs: { dir: "auto" }, content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] })), false));
await check("guard still blocks a non-default doc.dir", () =>
  assert.equal(isLossy(inspectContent({ type: "doc", attrs: { dir: "rtl" }, content: [] })), true));

// The guard fails closed on anything that is not a ProseMirror document,
// and on type names that exist on Object.prototype.
for (const [label, doc] of [
  ["undefined content", undefined],
  ["null content", null],
  ["string content", "# markdown"],
  ["non-doc root", { type: "paragraph", content: [] }],
  ["prototype node type", { type: "doc", content: [{ type: "constructor" }] }],
  ["prototype mark type", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "toString" }] }] }] }],
  ["prototype attribute", { type: "doc", content: [{ type: "paragraph", attrs: { constructor: "x" } }] }],
]) {
  await check(`guard blocks ${label}`, () => assert.ok(isLossy(inspectContent(doc))));
}

// Every mutating tool refuses, and writes nothing, when Docmost returns a
// page without usable content.
async function fakeDocmost(content) {
  const writes = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/auth/login") {
        res.setHeader("set-cookie", "authToken=t; Path=/");
        return res.end("{}");
      }
      if (req.url === "/api/pages/info") {
        const page = { id: "019e0000-0000-7000-8000-000000000001", spaceId: "s", title: "t" };
        if (content !== "omit") page.content = content;
        return res.end(JSON.stringify({ success: true, data: page }));
      }
      writes.push(req.url);
      res.end(JSON.stringify({ success: true, data: {} }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/api`, writes, close: () => server.close() };
}

const pageId = "019e0000-0000-7000-8000-000000000001";
for (const [label, content] of [
  ["no content field", "omit"],
  ["Markdown string content", "# hello"],
  ["non-doc object", { type: "paragraph" }],
]) {
  const fake = await fakeDocmost(content);
  const backupDir = await mkdtemp(join(tmpdir(), "mcp-unit-"));
  const srv = mcpServer({ DOCMOST_API_URL: fake.url, DOCMOST_EMAIL: "x", DOCMOST_PASSWORD: "x", DOCMOST_BACKUP_DIR: backupDir });
  const calls = [
    ["update_page", { pageId, content: "new", operation: "replace" }],
    ["update_page", { pageId, content: "new", operation: "replace", force: true }],
    ["update_page", { pageId, content: "new", operation: "append" }],
    ["update_page", { pageId, title: "renamed" }],
    ["move_page", { pageId, parentPageId: null }],
    ["delete_page", { pageId }],
  ];
  for (const [tool, args] of calls) {
    const r = await srv.call(tool, args);
    await check(`${label}: ${tool} ${args.operation || ""}${args.force ? " force" : ""} refuses`, () => {
      assert.equal(r.ok, false, r.text);
      assert.match(r.text, /Refusing to modify page/);
    });
  }
  const del = await srv.call("delete_pages", { pageIds: [pageId] });
  await check(`${label}: delete_pages refuses`, () => assert.equal(del.json?.[0]?.success, false));
  srv.close();
  fake.close();
  await check(`${label}: no write reached Docmost`, () => assert.deepEqual(fake.writes, []));
  await check(`${label}: no backup written`, async () => assert.deepEqual(await readdir(backupDir), []));
}

// A page that was never edited comes back with content: null. That is an
// empty document: every tool may change it, and the backup records null.
{
  const fake = await fakeDocmost(null);
  const backupDir = await mkdtemp(join(tmpdir(), "mcp-unit-"));
  const srv = mcpServer({ DOCMOST_API_URL: fake.url, DOCMOST_EMAIL: "x", DOCMOST_PASSWORD: "x", DOCMOST_BACKUP_DIR: backupDir });
  for (const [tool, args] of [
    ["update_page", { pageId, title: "renamed" }],
    ["update_page", { pageId, content: "new", operation: "replace" }],
    ["update_page", { pageId, content: "new", operation: "append" }],
    ["move_page", { pageId, parentPageId: null }],
    ["delete_page", { pageId }],
  ]) {
    const r = await srv.call(tool, args);
    await check(`null content: ${tool} ${args.operation || ""} allowed`, () => assert.equal(r.ok, true, r.text));
  }
  srv.close();
  fake.close();
  const files = await readdir(join(backupDir, pageId));
  await check("null content: each change wrote a write and a backup of null", async () => {
    assert.equal(fake.writes.length, 5);
    assert.equal(files.length, 5);
    for (const f of files) {
      const saved = JSON.parse(await readFile(join(backupDir, pageId, f), "utf-8"));
      assert.equal(saved.content, null);
    }
  });
}

// After a Markdown replace, headings whose text is unchanged get their old
// ids back (repeated texts pair up in order) in one JSON write. Docmost
// stores the Markdown write a little later, as the real one does.
async function statefulDocmost(initial, converted, { failJson = false, neverStore = false } = {}) {
  let content = initial;
  const writes = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/auth/login") {
        res.setHeader("set-cookie", "authToken=t; Path=/");
        return res.end("{}");
      }
      if (req.url === "/api/pages/info") {
        return res.end(JSON.stringify({ success: true, data: { id: pageId, spaceId: "s", title: "t", content } }));
      }
      const b = JSON.parse(body || "{}");
      writes.push({ url: req.url, format: b.format, content: b.content });
      if (req.url === "/api/pages/update" && b.format === "json" && failJson) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ message: "boom" }));
      }
      if (req.url === "/api/pages/update" && b.format === "markdown" && !neverStore) setTimeout(() => (content = converted), 400);
      if (req.url === "/api/pages/update" && b.format === "json") content = b.content;
      res.end(JSON.stringify({ success: true, data: {} }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/api`, writes, current: () => content, close: () => server.close() };
}

{
  const h = (id, text) => ({ type: "heading", attrs: { id, level: 2 }, content: [{ type: "text", text }] });
  const p = (id, text) => ({ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] });
  const before = { type: "doc", content: [h("oldalpha", "Alpha"), p("oldpara", "x"), h("oldbeta", "Beta"), h("oldalpha2", "Alpha"), h(null, "Gamma")] };
  const converted = { type: "doc", content: [h("new1", "Alpha"), h("new2", "Beta changed"), h("new3", "Alpha"), h("new4", "Alpha"), h("new5", "Gamma"), p("new6", "y")] };
  const fake = await statefulDocmost(before, converted);
  const backupDir = await mkdtemp(join(tmpdir(), "mcp-unit-"));
  const srv = mcpServer({ DOCMOST_API_URL: fake.url, DOCMOST_EMAIL: "x", DOCMOST_PASSWORD: "x", DOCMOST_BACKUP_DIR: backupDir });
  const r = await srv.call("update_page", { pageId, content: "## Alpha\n\n## Beta changed\n\n## Alpha\n\n## Alpha\n\n## Gamma\n\ny", operation: "replace" });
  const ids = fake.current().content.map((n) => n.attrs.id);
  await check("replace restores ids of headings with unchanged text", () => {
    assert.equal(r.ok, true, r.text);
    assert.deepEqual(ids, ["oldalpha", "new2", "oldalpha2", "new4", "new5", "new6"]);
    assert.deepEqual(r.json.headingIds, { kept: 2, of: 3, note: "1 heading(s) changed text or were removed, so their anchors changed." });
  });
  await check("id restore is one extra JSON write that changes only ids", () => {
    assert.deepEqual(fake.writes.map((w) => w.format), ["markdown", "json"]);
    const strip = (d) => JSON.stringify(d, (k, v) => (k === "id" ? undefined : v));
    assert.equal(strip(fake.writes[1].content), strip(converted));
  });
  const append = await srv.call("update_page", { pageId, content: "more", operation: "append" });
  await check("append does not touch heading ids", () => {
    assert.equal(append.json.headingIds, undefined);
    assert.equal(fake.writes.length, 3);
  });
  srv.close();
  fake.close();
}

// If restoring heading ids fails or times out, the content change still
// reports success, with a warning rather than an error.
for (const [label, opts] of [["restore write fails", { failJson: true }], ["new content never appears", { neverStore: true }]]) {
  const h = (id, text) => ({ type: "heading", attrs: { id, level: 2 }, content: [{ type: "text", text }] });
  const before = { type: "doc", content: [h("oldalpha", "Alpha")] };
  const fake = await statefulDocmost(before, { type: "doc", content: [h("new1", "Alpha")] }, opts);
  const backupDir = await mkdtemp(join(tmpdir(), "mcp-unit-"));
  const srv = mcpServer({
    DOCMOST_API_URL: fake.url, DOCMOST_EMAIL: "x", DOCMOST_PASSWORD: "x",
    DOCMOST_BACKUP_DIR: backupDir, DOCMOST_HEADING_ID_TIMEOUT_MS: "1500",
  });
  const r = await srv.call("update_page", { pageId, content: "## Alpha", operation: "replace" });
  await check(`${label}: replace succeeds with a warning`, () => {
    assert.equal(r.ok, true, r.text);
    assert.equal(r.json.success, true);
    assert.equal(r.json.headingIds.kept, 0);
    assert.match(r.json.warning, /Heading ids were not restored|did not appear in time/);
    assert.equal(r.json.warning, r.json.headingIds.warning);
  });
  srv.close();
  fake.close();
}

// Fake Docmost for the Phase 2 tools: routes maps an API path to a function
// of the request body returning the response data (or throwing to answer
// 400). Every request is recorded as { url, body }.
async function fakeApi(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/auth/login") {
        res.setHeader("set-cookie", "authToken=t; Path=/");
        return res.end("{}");
      }
      const parsed = JSON.parse(body || "{}");
      const path = req.url.replace(/^\/api/, "");
      requests.push({ url: path, body: parsed });
      const route = routes[path];
      if (!route) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ message: `no route ${path}` }));
      }
      try {
        res.end(JSON.stringify({ success: true, data: route(parsed) }));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ message: err.message }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/api`, requests, close: () => server.close() };
}

const toolServer = async (fake, extraEnv = {}) =>
  mcpServer({
    DOCMOST_API_URL: fake.url, DOCMOST_EMAIL: "x", DOCMOST_PASSWORD: "x",
    DOCMOST_BACKUP_DIR: await mkdtemp(join(tmpdir(), "mcp-unit-")), ...extraEnv,
  });

// list_child_pages follows the cursor to the end and needs pageId or spaceId.
{
  const fake = await fakeApi({
    "/pages/sidebar-pages": (b) =>
      b.cursor
        ? { items: [{ id: "c3", title: "Three", hasChildren: false }], meta: { hasNextPage: false } }
        : { items: [{ id: "c1", title: "One", hasChildren: true, position: "a0" }, { id: "c2", title: "Two" }], meta: { hasNextPage: true, nextCursor: "n1" } },
  });
  const srv = await toolServer(fake);
  const r = await srv.call("list_child_pages", { pageId });
  const none = await srv.call("list_child_pages", {});
  srv.close();
  fake.close();
  await check("list_child_pages returns every page across cursors, trimmed", () => {
    assert.equal(r.ok, true, r.text);
    assert.deepEqual(r.json, [
      { id: "c1", title: "One", hasChildren: true },
      { id: "c2", title: "Two", hasChildren: false },
      { id: "c3", title: "Three", hasChildren: false },
    ]);
    assert.deepEqual(fake.requests.map((q) => q.body.cursor), [undefined, "n1"]);
    assert.equal(fake.requests[0].body.pageId, pageId);
  });
  await check("list_child_pages without pageId or spaceId fails with guidance", () => {
    assert.equal(none.ok, false);
    assert.match(none.text, /Pass pageId .* or spaceId/);
  });
}

// get_breadcrumbs and get_space trim Docmost's responses.
{
  const fake = await fakeApi({
    "/pages/breadcrumbs": () => [
      { id: "root", title: "Root", spaceId: "s", slugId: "x", position: "a0", hasChildren: true },
      { id: pageId, title: "Leaf", spaceId: "s", slugId: "y", hasChildren: false },
    ],
    "/spaces/info": () => ({ id: "s", name: "Inbox", slug: "inbox", visibility: "private", memberCount: 2, membership: { role: "admin" }, settings: {} }),
  });
  const srv = await toolServer(fake);
  const crumbs = await srv.call("get_breadcrumbs", { pageId });
  const space = await srv.call("get_space", { spaceId: "s" });
  srv.close();
  fake.close();
  await check("get_breadcrumbs returns root-to-page ids and titles only", () =>
    assert.deepEqual(crumbs.json, [
      { id: "root", title: "Root", spaceId: "s" },
      { id: pageId, title: "Leaf", spaceId: "s" },
    ]));
  await check("get_space returns space fields and member count, not membership", () => {
    assert.equal(space.json.name, "Inbox");
    assert.equal(space.json.memberCount, 2);
    assert.equal(space.json.membership, undefined);
  });
}

// get_page_history returns one page plus nextCursor; get_page_version
// renders Markdown with the lossy notice, or exact JSON.
{
  const statusDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi " }, { type: "status", attrs: { text: "Done", color: "green" } }] }] };
  const fake = await fakeApi({
    "/pages/history": (b) => ({
      items: [{ id: "h2", title: "T", createdAt: "2026-10-27T10:00:00Z", lastUpdatedBy: { id: "u", name: "Ross", avatarUrl: null }, contributors: [{ id: "u", name: "Ross" }], content: "x" }],
      meta: b.cursor ? { hasNextPage: false } : { hasNextPage: true, nextCursor: "c2" },
    }),
    "/pages/history/info": () => ({ id: "h2", pageId, title: "T", createdAt: "2026-10-27T10:00:00Z", lastUpdatedBy: { name: "Ross" }, content: statusDoc }),
  });
  const srv = await toolServer(fake);
  const hist = await srv.call("get_page_history", { pageId, limit: 1 });
  const md = await srv.call("get_page_version", { historyId: "h2" });
  const js = await srv.call("get_page_version", { historyId: "h2", format: "json" });
  srv.close();
  fake.close();
  await check("get_page_history returns versions and nextCursor, without content", () => {
    assert.deepEqual(hist.json, {
      versions: [{ historyId: "h2", title: "T", createdAt: "2026-10-27T10:00:00Z", lastUpdatedBy: "Ross", contributors: ["Ross"] }],
      nextCursor: "c2",
    });
    assert.equal(fake.requests[0].body.limit, 1);
  });
  await check("get_page_version markdown flags what it cannot show", () =>
    assert.match(md.json.content, /^> Note: .*status .*get_page_version with format "json"/));
  await check("get_page_version json returns the exact content", () =>
    assert.deepEqual(js.json.content, statusDoc));
}

// list_trash pages through the trash; restore_page backs up, refuses a page
// that is not in the trash, and says when the page lands at the root.
{
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] };
  let deletedAt = "2026-10-27T10:00:00Z";
  const fake = await fakeApi({
    "/pages/trash": () => ({ items: [{ id: pageId, title: "Gone", parentPageId: "p", deletedAt, deletedBy: { name: "Ross" } }], meta: { hasNextPage: false } }),
    "/pages/info": () => ({ id: pageId, spaceId: "s", title: "Gone", parentPageId: "p", deletedAt, content: doc }),
    "/pages/restore": () => { deletedAt = null; return { id: pageId, title: "Gone", parentPageId: null }; },
  });
  const srv = await toolServer(fake);
  const trash = await srv.call("list_trash", { spaceId: "s" });
  const restored = await srv.call("restore_page", { pageId });
  const again = await srv.call("restore_page", { pageId });
  srv.close();
  fake.close();
  await check("list_trash returns trashed pages with who deleted them", () =>
    assert.deepEqual(trash.json, { pages: [{ id: pageId, title: "Gone", parentPageId: "p", deletedAt: "2026-10-27T10:00:00Z", deletedBy: "Ross" }], nextCursor: null }));
  await check("restore_page backs up, restores and reports the move to the root", () => {
    assert.equal(restored.ok, true, restored.text);
    assert.match(restored.json.backup, /_restore\.json$/);
    assert.match(restored.json.message, /now at the space root/);
  });
  await check("restore_page refuses a page that is not in the trash", () => {
    assert.equal(again.ok, false);
    assert.match(again.text, /not in the trash/);
    assert.equal(fake.requests.filter((q) => q.url === "/pages/restore").length, 1);
  });
}

// move_page_to_space backs up, moves, confirms the new space, and refuses a
// move to the space the page is already in.
{
  const doc = { type: "doc", content: [] };
  let space = "s1";
  const fake = await fakeApi({
    "/pages/info": () => ({ id: pageId, spaceId: space, title: "T", parentPageId: "p", content: doc }),
    "/pages/move-to-space": (b) => { space = b.spaceId; return null; },
  });
  const srv = await toolServer(fake);
  const moved = await srv.call("move_page_to_space", { pageId, spaceId: "s2" });
  const same = await srv.call("move_page_to_space", { pageId, spaceId: "s2" });
  srv.close();
  fake.close();
  await check("move_page_to_space backs up, moves and reports where it came from", () => {
    assert.equal(moved.ok, true, moved.text);
    assert.deepEqual(moved.json.from, { spaceId: "s1", parentPageId: "p" });
    assert.match(moved.json.backup, /_move-to-space\.json$/);
  });
  await check("move_page_to_space refuses the page's own space and writes nothing", () => {
    assert.equal(same.ok, false);
    assert.match(same.text, /already in space s2/);
    assert.equal(fake.requests.filter((q) => q.url === "/pages/move-to-space").length, 1);
  });
}

// duplicate_page backs up the source and reports the copy.
{
  const fake = await fakeApi({
    "/pages/info": () => ({ id: pageId, spaceId: "s1", title: "T", parentPageId: null, content: { type: "doc", content: [] } }),
    "/pages/duplicate": (b) => ({ id: "copy", title: b.spaceId ? "T" : "Copy of T", spaceId: b.spaceId ?? "s1", parentPageId: null, childPageIds: ["k1", "k2"] }),
  });
  const srv = await toolServer(fake);
  const same = await srv.call("duplicate_page", { pageId });
  const other = await srv.call("duplicate_page", { pageId, spaceId: "s2" });
  srv.close();
  fake.close();
  await check("duplicate_page returns the copy and how many child pages came with it", () => {
    assert.equal(same.json.newPageId, "copy");
    assert.equal(same.json.title, "Copy of T");
    assert.equal(same.json.copiedChildPages, 2);
    assert.match(same.json.backup, /_duplicate\.json$/);
    assert.equal(other.json.spaceId, "s2");
    assert.equal(fake.requests.find((q) => q.url === "/pages/duplicate").body.spaceId, undefined);
  });
}

// list_page_backups and restore_page_backup: a page with tabs and columns
// is damaged by a forced Markdown replace, then restored to exact JSON.
{
  const original = fixtures.find(([n]) => n === "tabs")[1];
  const columns = fixtures.find(([n]) => n === "columns")[1];
  const rich = { type: "doc", content: [...original.content, ...columns.content] };
  const state = { title: "Rich", content: rich, deletedAt: null, spaceId: "s", parentPageId: null };
  const fake = await fakeApi({
    "/pages/info": () => ({ id: pageId, ...state }),
    "/pages/update": (b) => {
      if (b.title) state.title = b.title;
      if (b.content !== undefined) {
        state.content = b.format === "json" ? b.content : { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "flattened" }] }] };
      }
      return {};
    },
  });
  // Keep only one backup per page: restoring must still work although taking
  // the pre-restore backup prunes the one being restored.
  const srv = await toolServer(fake, { DOCMOST_BACKUP_KEEP: "1", DOCMOST_HEADING_ID_TIMEOUT_MS: "2000" });
  const damage = await srv.call("update_page", { pageId, title: "Damaged", content: "flattened", operation: "replace", force: true });
  const list = await srv.call("list_page_backups", { pageId });
  const name = list.json?.backups?.[0]?.backup;
  const restored = await srv.call("restore_page_backup", { pageId, backup: name });
  const traversal = await srv.call("restore_page_backup", { pageId, backup: "../../etc/passwd" });
  const gone = await srv.call("restore_page_backup", { pageId, backup: name });
  const after = await srv.call("list_page_backups", { pageId });
  state.deletedAt = "2026-10-27T10:00:00Z";
  const trashed = await srv.call("restore_page_backup", { pageId, backup: after.json.backups[0].backup });
  srv.close();
  fake.close();
  await check("list_page_backups lists the backup taken before the replace", () => {
    assert.equal(damage.ok, true, damage.text);
    assert.equal(list.json.backups.length, 1);
    assert.equal(list.json.backups[0].takenBefore, "replace");
    assert.equal(list.json.backups[0].title, "Rich");
  });
  await check("restore_page_backup brings back tabs and columns exactly, and the title", () => {
    assert.equal(restored.ok, true, restored.text);
    assert.equal(restored.json.verified, "exact");
    assert.equal(canonicalJson(state.content), canonicalJson(rich));
    assert.equal(state.title, "Rich");
    assert.match(restored.json.backup, /_pre-restore\.json$/);
  });
  await check("with keep=1 the restored backup was pruned only after it was read", () => {
    assert.deepEqual(after.json.backups.map((b) => b.takenBefore), ["pre-restore"]);
    assert.match(gone.text, /No backup .* may have expired/);
  });
  await check("restore_page_backup refuses a path instead of a backup name", () => {
    assert.equal(traversal.ok, false);
    assert.match(traversal.text, /not a backup file name/);
  });
  await check("restore_page_backup refuses a page in the trash", () => {
    assert.equal(trashed.ok, false);
    assert.match(trashed.text, /in the trash\. restore_page it first/);
  });
  await check("restore wrote exactly one JSON replace", () =>
    assert.equal(fake.requests.filter((q) => q.url === "/pages/update" && q.body.format === "json").length, 1));
}

// Backup folders are owner-only, and the startup sweep expires old backups
// across all pages, including a page's newest once it is past the limit.
{
  const dir = join(await mkdtemp(join(tmpdir(), "mcp-backup-")), "backups");
  const store = new BackupStore(dir, 20, 90);
  const now = new Date().toISOString();
  await store.save({ pageId, title: "t", spaceId: "s", parentPageId: null, operation: "replace", capturedAt: now, content: { type: "doc" } });
  const mode = async (p) => (await stat(p)).mode & 0o777;
  const [file] = await readdir(join(dir, pageId));
  await check("backup root and page folder are 0700, file is 0600", async () => {
    assert.equal(await mode(dir), 0o700);
    assert.equal(await mode(join(dir, pageId)), 0o700);
    assert.equal(await mode(join(dir, pageId, file)), 0o600);
  });

  const old = "2020-01-01T00-00-00-000Z";
  const orphan = "019e0000-0000-7000-8000-0000000000aa";
  await mkdir(join(dir, orphan), { mode: 0o700 });
  await writeFile(join(dir, orphan, `${old}_delete.json`), "{}");
  await writeFile(join(dir, pageId, `${old}_append.json`), "{}");
  await writeFile(join(dir, pageId, `.${old}_x.json.tmp`), "");
  const swept = await new BackupStore(dir, 20, 90).sweep();
  const left = await readdir(join(dir, pageId));
  await check("sweep removes expired backups, temp files and empty folders", () => {
    assert.deepEqual(swept, { pages: 2, removed: 3, emptied: 1 });
    assert.deepEqual(left, [file]);
  });
  const expiring = await new BackupStore(dir, 20, -1).sweep();
  await check("sweep expires a page's newest backup once past the limit", () =>
    assert.deepEqual(expiring, { pages: 1, removed: 1, emptied: 1 }));
}

// Tool names: one bad name breaks tool enumeration for the whole MCP hub.
const server = mcpServer({ DOCMOST_API_URL: "http://127.0.0.1:9/api", DOCMOST_EMAIL: "x", DOCMOST_PASSWORD: "x" });
const tools = await server.listTools();
server.close();
await check("tools listed", () => assert.ok(tools.length > 0));
for (const t of tools) {
  await check(`tool name: ${t.name}`, () => assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/));
}
await check("stdout carries protocol only", () => assert.deepEqual(server.strayStdout, []));

console.log(failures ? `${failures} failed` : `all ${checks} checks passed`);
process.exitCode = failures ? 1 : 0;
