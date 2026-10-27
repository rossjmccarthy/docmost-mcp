# Docmost MCP Server

A Model Context Protocol (MCP) server for [Docmost](https://docmost.com/),
letting AI agents search, read, create and edit pages. This is a fork of
[MrMartiniMo/docmost-mcp](https://github.com/MrMartiniMo/docmost-mcp)
(branch `homelab-fixes`), reworked so that agent edits cannot silently destroy
page content.

Tested against **Docmost 0.97.0 Community Edition**. It uses only the regular
REST API (no Enterprise features).

## Safety model

The design rule is that a missing feature is better than silent data loss.

- **Backups before every change.** Before any update, rename, append, prepend,
  move or delete, the server saves the page's exact ProseMirror JSON (with
  title, space and parent) to `DOCMOST_BACKUP_DIR`. If that save fails, the
  operation is aborted. Docmost's own page history is not a reliable undo for
  API writes, so these backups are.
- **Guarded Markdown replace.** Replacing a page body with Markdown is only
  allowed when everything on the page is on an allow-list of content proven
  (by `tests/roundtrip.mjs`) to survive a Markdown round trip unchanged.
  Anything else (tabs, columns, status pills, callouts, embeds, comment
  anchors, colours, alignment, and any type Docmost adds later) makes
  `update_page` refuse, naming what would be lost. `force: true` overrides
  this; the backup is still taken.
  What is allowed today (see `src/lib/content-guard.ts`): paragraphs,
  headings, bullet/ordered/task lists, tables, code blocks, quotes,
  horizontal rules, hard breaks, callouts, details, images; bold, italic,
  code, strike, underline, sub/superscript, links (including internal page
  links), highlight and text colour. Non-default alignment, indent, table
  column widths, cell colours, open details blocks and marks combined with
  inline code also block, because Docmost's Markdown import cannot carry
  them. Docmost gives every heading and paragraph a new id on a Markdown
  write; after a replace the server puts back the previous id of each
  heading whose text is unchanged (with one extra write that changes only
  ids), so links to those headings keep working. The result's `headingIds`
  says how many were kept. Paragraph ids are not kept. If restoring the ids
  fails or times out (`DOCMOST_HEADING_ID_TIMEOUT_MS`, default 15000), the
  replace still reports success, with a `warning`.
- **HTML as an opt-in exact-ish format.** `get_page`, `create_page` and
  `update_page` take `format: "html"` (Docmost's own HTML). It keeps what
  Markdown loses: tabs, columns, status pills, page breaks, comment anchors,
  alignment, indent, table column widths and cell colours (54 of 61 harness
  fixtures round-trip exactly in `html>html` mode). An HTML replace has its
  own allow-list; still blocked under HTML: footnotes (Docmost's HTML export
  fails on them), attachments, audio, PDF and embeds (numeric sizes come back
  as strings), open details blocks, marks combined with inline code, and
  unknown types. `get_page` HTML notes, in an HTML comment, anything HTML
  cannot represent. HTML also drops heading ids, which are restored the
  same way as after a Markdown replace.
- **append and prepend are always safe.** They add new blocks without
  touching existing ones, so they skip the guard (and still back up).
- **Honest reads.** `get_page` returns Markdown by default, and starts the
  content with a note whenever the page holds something Markdown cannot
  represent. `format: "json"` returns the exact content.
- **Deletes go to the trash.** Nothing in the tool surface deletes
  permanently.

## Tools

| Tool | What it does | Reversible? |
| --- | --- | --- |
| `search` | Full-text search; optional `spaceId`, `titleOnly`, `limit`, `offset` | Read-only |
| `get_workspace`, `list_spaces`, `list_groups` | Workspace information | Read-only |
| `list_pages` | Pages in a space, most recently updated first | Read-only |
| `get_page` | Page details and content (`format`: `markdown`, `json` or `html`) | Read-only |
| `list_child_pages` | A page's direct children, or a space's top-level pages | Read-only |
| `get_breadcrumbs` | A page's ancestors from the space root | Read-only |
| `get_space` | One space's details and member count | Read-only |
| `get_page_history`, `get_page_version` | Docmost's saved versions of a page, and one version's content | Read-only |
| `list_page_backups` | This server's own pre-write backups of a page | Read-only |
| `get_comments` | A page's comments, with author, anchor text and resolved state | Read-only |
| `list_page_labels`, `get_backlinks` | Labels; pages linking to or from a page | Read-only |
| `list_trash` | A space's trashed pages | Read-only |
| `create_page` | New page from Markdown or HTML, optionally under a parent; title set exactly | Yes (trash it) |
| `update_page` | Title and/or content; `operation`: `replace` (guarded), `append`, `prepend`; `format`; `force` | Yes (backup) |
| `move_page` | Move within a space | Yes (backup; move back) |
| `move_page_to_space` | Move a page and everything under it to another space's root | Yes (backup; move back) |
| `duplicate_page` | Copy a page and everything under it, in the same space or into another | Yes (trash the copy) |
| `restore_page` | Restore a page (and what is under it) from the trash | Yes (backup; trash it again) |
| `restore_page_backup` | Put a page's content and title back to one of its backups, exact JSON | Yes (takes a pre-restore backup) |
| `reply_to_comment` | Plain-text reply in a comment thread | Delete it in Docmost |
| `add_page_labels`, `remove_page_label` | Change a page's labels | Yes (the other one) |
| `delete_page`, `delete_pages` | Move to the Docmost trash | Yes (backup; `restore_page`) |

Lists that can be long (history, trash, comments, backlinks) return one page
of results and a `nextCursor` to pass back for the next. Not provided, on
purpose: permanent deletion, space create/update/delete, member and
permission management, new comments anchored to page text (they need the
Yjs client this fork removed), resolving or deleting comments.

When Docmost refuses a request, tools fail with the endpoint, the HTTP
status and Docmost's own reason, never with credentials.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `DOCMOST_API_URL` | yes | Docmost API base, e.g. `http://docmost:3000/api` |
| `DOCMOST_EMAIL`, `DOCMOST_PASSWORD` | yes | Login for the account the agent acts as |
| `DOCMOST_BACKUP_DIR` | for any write | Directory for pre-write backups. **Must be persistent storage.** If unset, every mutating tool refuses. |
| `DOCMOST_BACKUP_KEEP` | no (20) | Backups kept per page |
| `DOCMOST_BACKUP_MAX_AGE_DAYS` | no (90) | Backups older than this are pruned |
| `DOCMOST_MARKDOWN_READER` | no (`fork`) | Markdown converter for `get_page`: `fork` or `native` (Docmost's) |
| `DOCMOST_HEADING_ID_TIMEOUT_MS` | no (15000) | How long a replace waits to restore heading ids, and a backup restore waits to verify |

Backups are written as `<DOCMOST_BACKUP_DIR>/<pageId>/<timestamp>_<operation>.json`
with mode 600, in folders with mode 700. After each new backup the page's
older ones are pruned to `DOCMOST_BACKUP_KEEP` and `DOCMOST_BACKUP_MAX_AGE_DAYS`,
always keeping the one just written. At startup the server sweeps every page
folder with the age limit alone, so backups of pages that are never written
again (including deleted ones) also expire; the sweep can remove a page's
last backup. They contain full page content, so treat the directory as
sensitive and include it in your own backups.

A page Docmost returns without a ProseMirror document cannot be checked or
backed up, so every tool that changes it refuses. The exception is a page
that was never edited: Docmost returns it with `content: null`, which is
treated as an empty document (and backed up as `null`). A missing content
field, or content of any other shape, is still refused.

## Usage with an MCP client

```json
{
  "mcpServers": {
    "docmost": {
      "command": "node",
      "args": ["./build/index.js"],
      "env": {
        "DOCMOST_API_URL": "http://localhost:3000/api",
        "DOCMOST_EMAIL": "agent@example.com",
        "DOCMOST_PASSWORD": "change-me",
        "DOCMOST_BACKUP_DIR": "/var/lib/docmost-mcp/backups"
      }
    }
  }
}
```

The server speaks MCP over stdio; nothing else is written to stdout.

## Tests

`npm test` runs offline: it checks the guard's verdict (Markdown and HTML)
on every fixture, that every tool name matches `^[a-zA-Z0-9_-]{1,64}$`, and
every tool's behaviour against a fake Docmost, including refusals.

The live tests need `DOCMOST_API_URL`, `DOCMOST_EMAIL` and
`DOCMOST_PASSWORD`, and work in one space only (`MCPTEST_SPACE_ID`). They only
create pages titled `MCPTEST ...` and permanently delete them afterwards, also
when interrupted. Run them from somewhere that can reach Docmost, and never
commit the credentials.

```bash
npm run test:roundtrip            # fidelity per node/mark/attribute; add fixture names to run a subset
npm run test:acceptance           # behaviour checks (guard, backups, titles, ...)
npm run test:acceptance2          # the Phase 2 tools (tree, trash, backups restore, HTML, comments, labels)
HARNESS_MODES='html>html' npm run test:roundtrip   # one mode only (fork>native, native>native, html>html)
node tests/scan-impact.mjs        # read-only: how many existing pages the guard would block
node tests/scan-anchors.mjs       # read-only: links that point at heading anchors
node tests/probe-ids.mjs          # one test page: how Docmost treats ids on JSON and Markdown writes
node tests/cleanup.mjs            # remove leftover MCPTEST pages
```

Optional for acceptance: `MCPTEST_SEARCH_QUERY` with the title it must find
in `MCPTEST_SEARCH_EXPECT`, and `MCPTEST_LIST_SPACE_ID` pointing at a space
with more than 100 pages to exercise pagination.

## Differences from upstream

- Writes use Docmost's native `/pages/create` and `/pages/update` (content
  plus `format` and `operation`) instead of `/pages/import` and a Yjs client.
  This keeps a leading heading on create and sets titles exactly.
- Pre-write backups, the allow-list guard, `append`/`prepend`, `force`, and
  `get_page` `format`.
- Search works on Docmost 0.97 (response shape changed) and exposes more
  options; list endpoints follow cursor pagination.
- New tools: page tree, breadcrumbs, space info, history, trash and
  restore, cross-space move, duplicate, backup restore, comments and
  replies, labels, backlinks; and the opt-in HTML format.

## License

MIT
