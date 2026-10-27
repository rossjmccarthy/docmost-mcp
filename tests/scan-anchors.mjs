// Read-only: find links that point at a heading anchor (#fragment), so we
// know what a Markdown rewrite's regenerated heading ids would break.
// Prints counts, plus source -> target page titles for links that resolve to
// a heading; never page content.
//
// Usage: node tests/scan-anchors.mjs
import { apiClient } from "./lib.mjs";

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

const textOf = (n) => (n.text || "") + (n.content || []).map(textOf).join("");
const slugify = (s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

const pages = [];
for (const space of await all("/spaces", {})) {
  for (const p of await all("/pages/recent", { spaceId: space.id })) {
    const info = await api.post("/pages/info", { pageId: p.id, includeContent: true, format: "json" });
    pages.push({ id: p.id, slugId: info.slugId, title: info.title || "(untitled)", content: info.content });
  }
}

// Heading ids and text slugs, per page.
const headingById = new Map(); // id -> { page, text }
const headingBySlug = new Map(); // `${pageSlugId}#${slug}` -> page
let headings = 0, headingsWithId = 0;
for (const page of pages) {
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "heading") {
      headings++;
      const text = textOf(n);
      if (n.attrs?.id) { headingsWithId++; headingById.set(n.attrs.id, { page, text }); }
      headingBySlug.set(`${page.slugId}#${slugify(text)}`, page);
    }
    (n.content || []).forEach(walk);
  };
  walk(page.content);
}

// Every href with a fragment, from link marks and from bare URLs in text.
const links = [];
for (const page of pages) {
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    for (const m of n.marks || []) {
      if (m.type === "link" && typeof m.attrs?.href === "string" && m.attrs.href.includes("#")) {
        links.push({ from: page, href: m.attrs.href, kind: "link" });
      }
    }
    if (n.type === "text" && !(n.marks || []).some((m) => m.type === "link")) {
      for (const url of n.text.match(/https?:\/\/\S+#\S+/g) || []) links.push({ from: page, href: url, kind: "text" });
    }
    (n.content || []).forEach(walk);
  };
  walk(page.content);
}

const byId = [], bySlug = [], external = [], unresolved = [];
for (const l of links) {
  const frag = decodeURIComponent(l.href.split("#").pop());
  const h = headingById.get(frag);
  if (h) { byId.push({ ...l, to: h.page, text: h.text }); continue; }
  const slugIdMatch = l.href.match(/-([A-Za-z0-9]{10,})(?:#|$)/) || l.href.match(/\/p\/([A-Za-z0-9]{10,})(?:#|$)/);
  const target = slugIdMatch && headingBySlug.get(`${slugIdMatch[1]}#${frag}`);
  if (target) { bySlug.push({ ...l, to: target }); continue; }
  if (/^https?:/.test(l.href) && !pages.some((p) => p.slugId && l.href.includes(p.slugId))) external.push(l);
  else unresolved.push(l);
}

console.log(`pages scanned: ${pages.length}; headings: ${headings} (${headingsWithId} with an id)`);
console.log(`hrefs with a #fragment: ${links.length} (${links.filter((l) => l.kind === "text").length} as plain text)`);
console.log(`  resolve to a heading id: ${byId.length}`);
for (const l of byId) console.log(`    "${l.from.title}" -> "${l.to.title}" # "${l.text.slice(0, 50)}"`);
console.log(`  resolve to a heading's text slug: ${bySlug.length}`);
for (const l of bySlug) console.log(`    "${l.from.title}" -> "${l.to.title}"`);
console.log(`  external sites: ${external.length}`);
console.log(`  internal or relative, not matching any heading: ${unresolved.length}`);
for (const l of unresolved) console.log(`    from "${l.from.title}": ${l.href.replace(/^https?:\/\/[^/]+/, "")}`);
