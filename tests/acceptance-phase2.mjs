// Acceptance checks for the Phase 2 tools, against a live Docmost through
// the MCP tools. Creates only "MCPTEST ..." pages in the test space and
// permanently deletes them (and any copies) at the end, also on interrupt.
//
// Cross-space checks (move_page_to_space, duplicate_page with spaceId) use
// the space named "MCPTEST Sandbox" as the second space, and clean it up too.
//
// Usage: npm run test:acceptance2
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { TEST_SPACE_ID, PREFIX, apiClient, mcpServer, cleanupOnInterrupt, settledWrite, normalize, sleep } from "./lib.mjs";
import { fixtures } from "./fixtures.mjs";

const api = await apiClient();
const backupDir = await mkdtemp(join(tmpdir(), "mcptest-acceptance2-"));
const tool = mcpServer({ DOCMOST_BACKUP_DIR: backupDir });
const created = [];
cleanupOnInterrupt(api, created);
const checks = [];
const SANDBOX_NAME = "MCPTEST Sandbox";
const spaces = await api.post("/spaces", { limit: 100 });
const sandboxId = (spaces.items || []).find((sp) => sp.name === SANDBOX_NAME)?.id ?? null;

const check = (name, pass, detail = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
};
const info = (msg) => console.log(`INFO  ${msg}`);
const fixture = (name) => fixtures.find(([n]) => n === name)[1];
const canonical = (v) =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const stored = async (pageId) => (await api.post("/pages/info", { pageId, includeContent: true, format: "json" })).content;

// A test page created from exact JSON, returned after one pass through
// Docmost's JSON write path so later reads compare like with like.
async function apiPage(name, content, parentPageId) {
  const page = await api.post("/pages/create", {
    spaceId: TEST_SPACE_ID, title: `${PREFIX} ${name}`, content, format: "json", ...(parentPageId ? { parentPageId } : {}),
  });
  created.push(page.id);
  const settled = await settledWrite(api, page.id, () =>
    api.post("/pages/update", { pageId: page.id, content, format: "json", operation: "replace" }));
  return { id: page.id, slugId: page.slugId, content: settled };
}
const para = (text) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

try {
  const tools = (await tool.listTools()).map((t) => t.name);
  const phase2 = ["list_child_pages", "get_breadcrumbs", "get_space", "get_page_history", "get_page_version",
    "list_trash", "restore_page", "move_page_to_space", "duplicate_page", "list_page_backups",
    "restore_page_backup", "get_comments", "reply_to_comment", "list_page_labels", "add_page_labels",
    "remove_page_label", "get_backlinks"];
  check("all Phase 2 tools are listed", phase2.every((t) => tools.includes(t)), phase2.filter((t) => !tools.includes(t)).join(", "));

  // Tree: parent P with two children.
  const P = await apiPage("tree parent", para("parent"));
  const c1 = await tool.call("create_page", { title: `${PREFIX} tree child one`, content: "one", spaceId: TEST_SPACE_ID, parentPageId: P.id });
  const c2 = await tool.call("create_page", { title: `${PREFIX} tree child two`, content: "two", spaceId: TEST_SPACE_ID, parentPageId: P.id });
  const C1 = c1.json?.data?.id, C2 = c2.json?.data?.id;
  created.push(C1, C2);

  const kids = await tool.call("list_child_pages", { pageId: P.id });
  check("list_child_pages lists a page's children", kids.ok && kids.json.length === 2 && kids.json.every((k) => [C1, C2].includes(k.id) && k.hasChildren === false), kids.text.slice(0, 120));
  const roots = await tool.call("list_child_pages", { spaceId: TEST_SPACE_ID });
  check("list_child_pages lists a space's root pages", roots.ok && roots.json.some((k) => k.id === P.id && k.hasChildren === true));
  const noArgs = await tool.call("list_child_pages", {});
  check("list_child_pages without pageId or spaceId fails cleanly", !noArgs.ok && /Pass pageId/.test(noArgs.text));

  const crumbs = await tool.call("get_breadcrumbs", { pageId: C1 });
  check("get_breadcrumbs goes from root to the page", crumbs.ok && crumbs.json.map((c) => c.id).join() === [P.id, C1].join(), crumbs.text.slice(0, 120));

  const space = await tool.call("get_space", { spaceId: TEST_SPACE_ID });
  check("get_space returns the space", space.ok && space.json.id === TEST_SPACE_ID && typeof space.json.name === "string", space.json?.name);
  const badSpace = await tool.call("get_space", { spaceId: "019e0000-0000-7000-8000-000000000000" });
  check("get_space on an unknown id fails with Docmost's reason", !badSpace.ok && /Docmost refused \/spaces\/info \(HTTP 4\d\d\)/.test(badSpace.text), badSpace.text.slice(0, 120));

  // History: Docmost may not have saved a version of API-written pages.
  const hist = await tool.call("get_page_history", { pageId: P.id });
  check("get_page_history answers", hist.ok && Array.isArray(hist.json.versions), hist.text.slice(0, 80));
  if (hist.json?.versions?.length) {
    const v = await tool.call("get_page_version", { historyId: hist.json.versions[0].historyId, format: "json" });
    check("get_page_version returns a version's JSON", v.ok && v.json.content?.type === "doc");
  } else {
    info("no saved versions for an API-created page (Docmost history is not a safety net, F5); get_page_version not exercised live");
  }

  // Backups: a page with tabs and columns, damaged by a forced Markdown
  // replace, then restored to exact JSON.
  const rich = { type: "doc", content: [...fixture("tabs").content, ...fixture("columns").content] };
  const R = await apiPage("restore rich", rich);
  const damage = await tool.call("update_page", { pageId: R.id, title: `${PREFIX} restore rich (damaged)`, content: "flattened", operation: "replace", force: true });
  await sleep(1500);
  const damaged = await stored(R.id);
  check("forced Markdown replace really destroyed tabs and columns", damage.ok && !JSON.stringify(damaged).includes('"tabs"'));
  const list = await tool.call("list_page_backups", { pageId: R.id });
  const first = list.json?.backups?.[0];
  check("list_page_backups lists the backup taken before the replace", list.ok && first?.takenBefore === "replace" && first?.title === `${PREFIX} restore rich`, list.text.slice(0, 160));
  const rb = await tool.call("restore_page_backup", { pageId: R.id, backup: first?.backup });
  const after = await stored(R.id);
  const afterInfo = await api.post("/pages/info", { pageId: R.id });
  check("restore_page_backup restores tabs and columns to an exact JSON match",
    rb.ok && rb.json.verified === "exact" && canonical(after) === canonical(R.content), `${rb.json?.verified ?? rb.text.slice(0, 120)}`);
  check("restore_page_backup restores the title", afterInfo.title === `${PREFIX} restore rich`, afterInfo.title);
  const list2 = await tool.call("list_page_backups", { pageId: R.id });
  check("the restore took its own pre-restore backup", list2.json?.backups?.[0]?.takenBefore === "pre-restore");
  const trav = await tool.call("restore_page_backup", { pageId: R.id, backup: "../../etc/passwd" });
  check("restore_page_backup refuses a path", !trav.ok && /not a backup file name/.test(trav.text));

  // HTML: read the rich page as HTML and write it back unchanged without
  // force; footnotes still block an HTML replace.
  const h = await tool.call("get_page", { pageId: R.id, format: "html" });
  const html = h.json?.data?.content ?? "";
  check("get_page html returns Docmost's HTML with no note for tabs/columns", h.ok && html.includes("tab") && !html.startsWith("<!--"), html.slice(0, 80));
  const hw = await tool.call("update_page", { pageId: R.id, content: html, operation: "replace", format: "html" });
  await sleep(2000);
  const afterHtml = await stored(R.id);
  check("HTML replace of a tabs/columns page is allowed and keeps it (ids aside)",
    hw.ok && canonical(normalize(afterHtml).doc) === canonical(normalize(R.content).doc), hw.ok ? JSON.stringify(hw.json.headingIds ?? {}) : hw.text.slice(0, 160));
  const F = await apiPage("footnotes", fixture("footnotes"));
  const fw = await tool.call("update_page", { pageId: F.id, content: "<p>x</p>", operation: "replace", format: "html" });
  check("HTML replace refused on a page with footnotes", !fw.ok && /HTML rewrite would lose or change: blocks: .*footnote/.test(fw.text), fw.text.slice(0, 160));
  const E = await apiPage("embed", fixture("embed"));
  const eh = await tool.call("get_page", { pageId: E.id, format: "html" });
  check("get_page html notes, in an HTML comment, what HTML cannot represent", eh.ok && /^<!-- Note: .*embed/.test(eh.json.data.content), eh.json?.data?.content?.slice(0, 120));

  // Duplicate in the same space (copies the children too).
  const dup = await tool.call("duplicate_page", { pageId: P.id });
  if (dup.json?.newPageId) created.push(dup.json.newPageId);
  check("duplicate_page copies a page and its children in the same space",
    dup.ok && dup.json.title === `Copy of ${PREFIX} tree parent` && dup.json.copiedChildPages === 2, dup.text.slice(0, 160));
  if (dup.json?.newPageId) {
    const copyKids = await tool.call("list_child_pages", { pageId: dup.json.newPageId });
    for (const k of copyKids.json || []) created.push(k.id);
    check("the copy has its own two children", copyKids.json?.length === 2);
  }
  const badDup = await tool.call("duplicate_page", { pageId: "019e0000-0000-7000-8000-000000000000" });
  check("duplicate_page on an unknown page fails cleanly", !badDup.ok, badDup.text.slice(0, 120));
  const sameSpace = await tool.call("move_page_to_space", { pageId: C1, spaceId: TEST_SPACE_ID });
  check("move_page_to_space refuses the page's own space", !sameSpace.ok && /already in space/.test(sameSpace.text));

  // Trash: trash a child, find it, restore it under its parent; then trash
  // the parent and restore a child alone, which lands at the root.
  await tool.call("delete_page", { pageId: C2 });
  const trash = await tool.call("list_trash", { spaceId: TEST_SPACE_ID });
  check("list_trash shows the trashed page", trash.ok && trash.json.pages.some((p) => p.id === C2));
  const rest = await tool.call("restore_page", { pageId: C2 });
  const c2info = await api.post("/pages/info", { pageId: C2 });
  check("restore_page restores under its parent", rest.ok && !c2info.deletedAt && c2info.parentPageId === P.id, rest.text.slice(0, 160));
  const notTrashed = await tool.call("restore_page", { pageId: C2 });
  check("restore_page refuses a page not in the trash", !notTrashed.ok && /not in the trash/.test(notTrashed.text));
  await tool.call("delete_page", { pageId: P.id });
  const alone = await tool.call("restore_page", { pageId: C1 });
  const c1info = await api.post("/pages/info", { pageId: C1 });
  check("restore_page of a child whose parent is trashed puts it at the root",
    alone.ok && !c1info.deletedAt && !c1info.parentPageId && /space root/.test(alone.json.message), alone.text.slice(0, 160));
  await tool.call("restore_page", { pageId: P.id });

  // Comments: a page-level comment made directly, then replies via the tool.
  const comment = await api.post("/comments/create", { pageId: R.id, content: JSON.stringify(para("MCPTEST question")), type: "page" });
  const reply = await tool.call("reply_to_comment", { commentId: comment.id, text: "MCPTEST answer\nline two" });
  const reply2 = await tool.call("reply_to_comment", { commentId: reply.json?.commentId, text: "MCPTEST reply to a reply" });
  const comments = await tool.call("get_comments", { pageId: R.id });
  const byId = Object.fromEntries((comments.json?.comments || []).map((c) => [c.id, c]));
  check("get_comments returns the comment with author and text", comments.ok && byId[comment.id]?.text === "MCPTEST question" && !!byId[comment.id]?.author, comments.text.slice(0, 160));
  check("reply_to_comment posts in the thread", reply.ok && byId[reply.json.commentId]?.parentCommentId === comment.id && /MCPTEST answer/.test(byId[reply.json.commentId]?.text));
  check("a reply to a reply goes to the thread root", reply2.ok && byId[reply2.json.commentId]?.parentCommentId === comment.id && /posted to its thread/.test(reply2.json.message));
  const pc = await tool.call("add_page_comment", { pageId: R.id, text: "MCPTEST page comment" });
  const after2 = await tool.call("get_comments", { pageId: R.id });
  const pcRow = (after2.json?.comments || []).find((c) => c.id === pc.json?.commentId);
  check("add_page_comment posts an unanchored page comment prefixed [Claude]",
    pc.ok && pcRow?.text === "[Claude] MCPTEST page comment" && pcRow?.type === "page" && !pcRow?.parentCommentId && !pcRow?.selection, pc.text.slice(0, 120));

  // Labels.
  const add = await tool.call("add_page_labels", { pageId: R.id, names: ["mcptest"] });
  const label = add.json?.labels?.find((l) => l.name === "mcptest");
  check("add_page_labels adds a label", add.ok && !!label, add.text.slice(0, 120));
  const badLabel = await tool.call("add_page_labels", { pageId: R.id, names: ["~nope"] });
  check("add_page_labels with an invalid name fails with Docmost's reason", !badLabel.ok && /Docmost refused .* \(HTTP 400\)/.test(badLabel.text), badLabel.text.slice(0, 160));
  const rem = label ? await tool.call("remove_page_label", { pageId: R.id, labelId: label.id }) : { ok: false, text: "no label" };
  check("remove_page_label removes it", rem.ok && !rem.json.labels.some((l) => l.name === "mcptest"));

  // Backlinks: a page that mentions P.
  await apiPage("links to parent", { type: "doc", content: [{ type: "paragraph", content: [
    { type: "text", text: "See " },
    { type: "mention", attrs: { id: "mcptest-m1", label: `${PREFIX} tree parent`, entityType: "page", entityId: P.id, slugId: P.slugId } },
  ] }] });
  await sleep(1500);
  const bl = await tool.call("get_backlinks", { pageId: P.id });
  check("get_backlinks answers", bl.ok && Array.isArray(bl.json.pages), bl.text.slice(0, 120));
  info(`get_backlinks incoming for the parent: ${bl.json?.pages?.map((p) => p.title).join(", ") || "none"}`);

  // Cross-space, between the test space and the sandbox only.
  check(`the "${SANDBOX_NAME}" space exists`, !!sandboxId);
  if (sandboxId) {
    const X = await apiPage("cross parent", para("cross"));
    const X1 = await apiPage("cross child", para("child"), X.id);
    const mv = await tool.call("move_page_to_space", { pageId: X.id, spaceId: sandboxId });
    const xi = await api.post("/pages/info", { pageId: X.id });
    const x1i = await api.post("/pages/info", { pageId: X1.id });
    check("move_page_to_space moves the page to the sandbox root, with its child",
      mv.ok && xi.spaceId === sandboxId && !xi.parentPageId && x1i.spaceId === sandboxId && x1i.parentPageId === X.id, mv.text.slice(0, 160));
    check("move_page_to_space reports where the page came from", mv.json?.from?.spaceId === TEST_SPACE_ID && mv.json?.to?.spaceId === sandboxId);
    const kids = await tool.call("list_child_pages", { pageId: X.id });
    check("the moved page still has its child", kids.json?.length === 1 && kids.json[0].id === X1.id);
    const back = await tool.call("move_page_to_space", { pageId: X.id, spaceId: TEST_SPACE_ID });
    const xb = await api.post("/pages/info", { pageId: X.id });
    const x1b = await api.post("/pages/info", { pageId: X1.id });
    check("move_page_to_space moves it back, child included", back.ok && xb.spaceId === TEST_SPACE_ID && x1b.spaceId === TEST_SPACE_ID && x1b.parentPageId === X.id);
    const cp = await tool.call("duplicate_page", { pageId: X.id, spaceId: sandboxId });
    if (cp.json?.newPageId) created.push(cp.json.newPageId);
    const cpKids = cp.json?.newPageId ? await tool.call("list_child_pages", { pageId: cp.json.newPageId }) : { json: [] };
    for (const k of cpKids.json || []) created.push(k.id);
    const cpi = cp.json?.newPageId ? await api.post("/pages/info", { pageId: cp.json.newPageId }) : {};
    check("duplicate_page with spaceId copies page and child into the sandbox, same title",
      cp.ok && cpi.spaceId === sandboxId && cpi.title === `${PREFIX} cross parent` && cp.json.copiedChildPages === 1 && cpKids.json?.length === 1, cp.text.slice(0, 160));
    const orig = await api.post("/pages/info", { pageId: X.id });
    check("the original stays in the test space", orig.spaceId === TEST_SPACE_ID && !orig.deletedAt);
  }
} finally {
  for (const id of created.filter(Boolean)) {
    await api.post("/pages/delete", { pageId: id, permanentlyDelete: true }).catch(() => {});
  }
  tool.close();
  check("stdout carries protocol only", tool.strayStdout.length === 0, tool.strayStdout[0] ?? "");
  const leftovers = [];
  for (const spaceId of [TEST_SPACE_ID, sandboxId].filter(Boolean)) {
    for (const path of ["/pages/trash", "/pages/recent"]) {
      const r = await api.post(path, { spaceId, limit: 100 });
      leftovers.push(...(r.items || []).filter((p) => /^(Copy of )?MCPTEST /.test(p.title || "")));
    }
  }
  check("no MCPTEST pages left in the test space, the sandbox, or their trash", leftovers.length === 0, leftovers.map((p) => p.title).join(", "));
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
