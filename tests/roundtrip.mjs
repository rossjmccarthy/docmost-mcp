// Round-trip harness: for each fixture, create a page from exact JSON, read
// it back through a converter, write that back through a writer, re-read the
// stored JSON and diff. Modes:
//   fork>native  get_page (fork Markdown converter) -> update_page (native Markdown)
//   native>native get_page (Docmost Markdown)       -> update_page (native Markdown)
//   html>html    Docmost HTML read -> Docmost HTML write (for comparison)
// Only test pages titled "MCPTEST ..." in the test space are touched, and all
// are permanently deleted at the end.
//
// Usage: npm run test:roundtrip [-- fixture-name ...]
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  ROOT, TEST_SPACE_ID, PREFIX, apiClient, mcpServer, cleanupOnInterrupt, settledWrite,
  normalize, diff, typesIn,
} from "./lib.mjs";
import { fixtures } from "./fixtures.mjs";

const only = process.argv.slice(2);
const selected = only.length ? fixtures.filter(([n]) => only.includes(n)) : fixtures;
const NOTE = /^> Note: this page contains[^\n]*\n\n/;

const api = await apiClient();
const backupDir = await mkdtemp(join(tmpdir(), "mcptest-backups-"));
const env = { DOCMOST_BACKUP_DIR: backupDir };
const forkTool = mcpServer({ ...env, DOCMOST_MARKDOWN_READER: "fork" });
const nativeTool = mcpServer({ ...env, DOCMOST_MARKDOWN_READER: "native" });

const created = [];
cleanupOnInterrupt(api, created);
const results = [];

async function readMarkdown(tool, pageId) {
  const r = await tool.call("get_page", { pageId });
  if (!r.ok) throw new Error(`get_page: ${r.text}`);
  return r.json.data.content.replace(NOTE, "");
}

async function writeMarkdownViaTool(pageId, md) {
  const r = await nativeTool.call("update_page", { pageId, content: md, operation: "replace", force: true });
  if (!r.ok) throw new Error(`update_page: ${r.text}`);
}

const modes = {
  "fork>native": async (pageId) => {
    const md = await readMarkdown(forkTool, pageId);
    return { md, write: () => writeMarkdownViaTool(pageId, md) };
  },
  "native>native": async (pageId) => {
    const md = await readMarkdown(nativeTool, pageId);
    return { md, write: () => writeMarkdownViaTool(pageId, md) };
  },
  "html>html": async (pageId) => {
    const html = (await api.post("/pages/info", { pageId, format: "html" })).content;
    return {
      md: html,
      write: () => api.post("/pages/update", { pageId, content: html, format: "html", operation: "replace" }),
    };
  },
};

const idList = (doc) => {
  const ids = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.attrs?.id && ["heading", "paragraph"].includes(n.type)) ids.push(n.attrs.id);
    (n.content || []).forEach(walk);
  };
  walk(doc);
  return ids.join(",");
};

try {
  for (const [name, fixture] of selected) {
    const row = { name, modes: {} };
    results.push(row);
    let pageId;
    try {
      const page = await api.post("/pages/create", {
        spaceId: TEST_SPACE_ID, title: `${PREFIX} ${name}`, content: fixture, format: "json",
      });
      pageId = page.id;
      created.push(pageId);
      // Canonical baseline: the fixture after one pass through Docmost's own
      // JSON write path, so defaults are filled in the same way as later reads.
      const baseline = await settledWrite(api, pageId, () =>
        api.post("/pages/update", { pageId, content: fixture, format: "json", operation: "replace" }));
      row.baseline = baseline;
      row.types = typesIn(baseline);
      const nb = normalize(baseline).doc;

      const wanted = process.env.HARNESS_MODES?.split(",");
      for (const [mode, run] of Object.entries(modes)) {
        if (wanted && !wanted.includes(mode)) continue;
        try {
          // Reset to the baseline, then read and write in this mode.
          await settledWrite(api, pageId, () =>
            api.post("/pages/update", { pageId, content: baseline, format: "json", operation: "replace" }));
          const { md, write } = await run(pageId);
          const after = await settledWrite(api, pageId, write);
          const d = diff(nb, normalize(after).doc);
          const lost = [...row.types.nodes].filter((t) => !typesIn(after).nodes.has(t));
          const lostMarks = [...row.types.marks].filter((t) => !typesIn(after).marks.has(t));
          row.modes[mode] = {
            exact: d.length === 0,
            idsKept: idList(baseline) === idList(after),
            lost, lostMarks, diff: d, text: md.slice(0, 400),
          };
        } catch (err) {
          row.modes[mode] = { exact: false, error: err.message };
        }
      }
    } catch (err) {
      row.error = err.message;
    }
    const cells = Object.entries(row.modes)
      .map(([m, r]) => `${m}=${r.error ? "ERR" : r.exact ? "ok" : "DIFF"}`)
      .join("  ");
    console.log(`${name.padEnd(26)} ${row.error ? "FIXTURE ERROR: " + row.error : cells}`);
  }
} finally {
  for (const id of created) {
    await api.post("/pages/delete", { pageId: id, permanentlyDelete: true }).catch((e) =>
      console.log(`cleanup failed for ${id}: ${e.message}`));
  }
  forkTool.close();
  nativeTool.close();
  const stray = [...forkTool.strayStdout, ...nativeTool.strayStdout];
  console.log(stray.length ? `STRAY STDOUT (${stray.length} lines): ${stray[0]}` : "stdout: protocol only");
  await writeFile(join(ROOT, "tests/roundtrip-results.json"), JSON.stringify(results, null, 2));
  console.log(`cleaned up ${created.length} test pages; results in tests/roundtrip-results.json`);
}
