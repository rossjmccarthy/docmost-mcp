// Permanently delete leftover harness pages: only pages in the test space or
// the "MCPTEST Sandbox" space (and their trash) whose title starts with
// "MCPTEST " (or "Copy of MCPTEST ", from duplicate_page). Nothing else is
// touched.
// Usage: node tests/cleanup.mjs
import { TEST_SPACE_ID, PREFIX, apiClient } from "./lib.mjs";

const api = await apiClient();

async function all(path, body) {
  const items = [];
  let cursor;
  for (let i = 0; i < 100; i++) {
    const data = await api.post(path, { ...body, limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...(data.items || []));
    if (!data.meta?.hasNextPage || !data.meta?.nextCursor) break;
    cursor = data.meta.nextCursor;
  }
  return items;
}

const sandboxId = (await all("/spaces", {})).find((s) => s.name === "MCPTEST Sandbox")?.id;
const spaceIds = [TEST_SPACE_ID, sandboxId].filter(Boolean);

// duplicate_page names a same-space copy "Copy of <title>".
const isTestPage = (p) =>
  spaceIds.includes(p.spaceId) && typeof p.title === "string" &&
  (p.title.startsWith(`${PREFIX} `) || p.title.startsWith(`Copy of ${PREFIX} `));

const targets = [];
for (const spaceId of spaceIds) {
  targets.push(...(await all("/pages/recent", { spaceId })), ...(await all("/pages/trash", { spaceId })));
}
const seen = new Set();
let deleted = 0;
for (const p of targets.filter(isTestPage)) {
  if (seen.has(p.id)) continue;
  seen.add(p.id);
  await api.post("/pages/delete", { pageId: p.id, permanentlyDelete: true }).catch(() => {});
  deleted++;
}
console.log(`permanently deleted ${deleted} leftover ${PREFIX} pages (${spaceIds.length} space(s) checked)`);
