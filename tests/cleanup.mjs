// Permanently delete leftover harness pages: only pages in the test space
// (and its trash) whose title starts with "MCPTEST " (or "Copy of MCPTEST ",
// from duplicate_page). Nothing else is touched.
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

// duplicate_page names a same-space copy "Copy of <title>".
const isTestPage = (p) =>
  p.spaceId === TEST_SPACE_ID && typeof p.title === "string" &&
  (p.title.startsWith(`${PREFIX} `) || p.title.startsWith(`Copy of ${PREFIX} `));

const live = await all("/pages/recent", { spaceId: TEST_SPACE_ID });
const trashed = await all("/pages/trash", { spaceId: TEST_SPACE_ID });
const targets = [...live, ...trashed].filter(isTestPage);
for (const p of targets) {
  await api.post("/pages/delete", { pageId: p.id, permanentlyDelete: true });
}
console.log(`permanently deleted ${targets.length} leftover ${PREFIX} pages`);
