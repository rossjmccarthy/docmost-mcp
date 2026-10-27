// Read-only: how many existing pages would the Markdown-replace guard block,
// and why. Prints aggregate counts only, never titles or content.
//
// Usage: npm run build && node tests/scan-impact.mjs
import { join } from "path";
import { ROOT, apiClient } from "./lib.mjs";

const { inspectContent, isLossy } = await import(join(ROOT, "build/lib/content-guard.js"));
const api = await apiClient();

async function all(path, body) {
  const items = [];
  let cursor;
  for (let i = 0; i < 200; i++) {
    const data = await api.post(path, { ...body, limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...(data.items || []));
    if (!data.meta?.hasNextPage || !data.meta?.nextCursor) break;
    cursor = data.meta.nextCursor;
  }
  return items;
}

const tally = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const nodes = new Map(), marks = new Map(), attrs = new Map();
let pages = 0, lossy = 0, attrOnly = 0, empty = 0;

for (const space of await all("/spaces", {})) {
  for (const page of await all("/pages/recent", { spaceId: space.id })) {
    const content = (await api.post("/pages/info", { pageId: page.id })).content;
    pages++;
    if (!content) { empty++; continue; }
    const f = inspectContent(content);
    if (!isLossy(f)) continue;
    lossy++;
    if (!Object.keys(f.nodes).length && !Object.keys(f.marks).length) attrOnly++;
    Object.keys(f.nodes).forEach((t) => tally(nodes, t));
    Object.keys(f.marks).forEach((t) => tally(marks, t));
    f.attrs.forEach((a) => tally(attrs, `${a.type}.${a.attr}`));
  }
}

const show = (label, m) =>
  console.log(`${label}: ` + ([...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ") || "none"));
console.log(`pages scanned: ${pages} (empty: ${empty})`);
console.log(`would block a Markdown replace: ${lossy} (${attrOnly} only because of attributes)`);
show("pages with blocking node types", nodes);
show("pages with blocking marks", marks);
show("pages with blocking attributes", attrs);
