// Offline checks (no Docmost needed): the guard's verdict on every fixture,
// and tool names valid for MCP hubs. Run with: npm test
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readdir, stat, writeFile, mkdir } from "node:fs/promises";
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
  ["null content", null],
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
