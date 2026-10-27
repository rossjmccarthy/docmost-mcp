// Offline checks (no Docmost needed): the guard's verdict on every fixture,
// and tool names valid for MCP hubs. Run with: npm test
import assert from "node:assert/strict";
import { join } from "path";
import { ROOT, mcpServer } from "./lib.mjs";
import { fixtures } from "./fixtures.mjs";

const { inspectContent, isLossy } = await import(join(ROOT, "build/lib/content-guard.js"));

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
const check = (name, fn) => {
  try {
    fn();
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
};

for (const [name, doc] of fixtures) {
  check(`guard: ${name}`, () =>
    assert.equal(!isLossy(inspectContent(doc)), ALLOWED.has(name),
      ALLOWED.has(name) ? "proven exact but blocked" : "lossy but allowed"));
}
for (const name of ALLOWED) {
  check(`fixture exists: ${name}`, () => assert.ok(fixtures.some(([n]) => n === name)));
}

// Tool names: one bad name breaks tool enumeration for the whole MCP hub.
const server = mcpServer({ DOCMOST_API_URL: "http://127.0.0.1:9/api", DOCMOST_EMAIL: "x", DOCMOST_PASSWORD: "x" });
const tools = await server.listTools();
server.close();
check("tools listed", () => assert.ok(tools.length > 0));
for (const t of tools) {
  check(`tool name: ${t.name}`, () => assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/));
}
check("stdout carries protocol only", () => assert.deepEqual(server.strayStdout, []));

console.log(failures ? `${failures} failed` : `all ${fixtures.length + ALLOWED.size + tools.length + 2} checks passed`);
process.exitCode = failures ? 1 : 0;
