// Live probe: does Docmost keep heading/paragraph ids supplied in a JSON
// write, and what does a Markdown replace do to them? Uses one MCPTEST page
// in the test space and permanently deletes it.
import { TEST_SPACE_ID, PREFIX, apiClient, cleanupOnInterrupt, settledWrite } from "./lib.mjs";

const api = await apiClient();
const created = [];
cleanupOnInterrupt(api, created);

const doc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { id: "probeheadaaa", level: 2 }, content: [{ type: "text", text: "Alpha" }] },
    { type: "paragraph", attrs: { id: "probeparaaaa" }, content: [{ type: "text", text: "one" }] },
    { type: "heading", attrs: { id: "probeheadbbb", level: 2 }, content: [{ type: "text", text: "Beta" }] },
  ],
};
const ids = (c) => (c?.content || []).map((n) => `${n.type}:${n.attrs?.id}`).join(" ");

try {
  const page = await api.post("/pages/create", { spaceId: TEST_SPACE_ID, title: `${PREFIX} id probe`, content: doc, format: "json" });
  created.push(page.id);
  const pageId = page.id;
  const read = async () => (await api.post("/pages/info", { pageId, includeContent: true, format: "json" })).content;
  console.log("after JSON create:   ", ids(await read()));
  const afterJson = await settledWrite(api, pageId, () =>
    api.post("/pages/update", { pageId, content: doc, format: "json", operation: "replace" }));
  console.log("after JSON replace:  ", ids(afterJson));
  const afterMd = await settledWrite(api, pageId, () =>
    api.post("/pages/update", { pageId, content: "## Alpha\n\none\n\n## Beta\n", format: "markdown", operation: "replace" }));
  console.log("after Markdown repl: ", ids(afterMd));
  // Put the original ids back by text, as update_page would.
  const patched = structuredClone(afterMd);
  patched.content[0].attrs.id = "probeheadaaa";
  patched.content[2].attrs.id = "probeheadbbb";
  const afterPatch = await settledWrite(api, pageId, () =>
    api.post("/pages/update", { pageId, content: patched, format: "json", operation: "replace" }));
  console.log("after JSON id patch: ", ids(afterPatch));
  // Duplicate id: does Docmost dedupe?
  const dup = structuredClone(afterPatch);
  dup.content[1].attrs.id = "probeheadaaa";
  console.log("duplicate id write:  ", ids(await settledWrite(api, pageId, () =>
    api.post("/pages/update", { pageId, content: dup, format: "json", operation: "replace" }))));
} finally {
  for (const id of created) await api.post("/pages/delete", { pageId: id, permanentlyDelete: true });
  console.log(`cleaned up ${created.length} test page(s)`);
}
