// Round-trip fixtures. Each isolates one feature so a failure points at the
// node, mark or attribute responsible. Shapes follow Docmost v0.97.0
// packages/editor-ext/src/lib.

const t = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const p = (...content) => ({ type: "paragraph", content: content.map((c) => (typeof c === "string" ? t(c) : c)) });
const h = (level, text) => ({ type: "heading", attrs: { level }, content: [t(text)] });
const doc = (...content) => ({ type: "doc", content });
const li = (...content) => ({ type: "listItem", content });
const cell = (type, ...content) => ({ type, attrs: { colspan: 1, rowspan: 1 }, content: content.length ? content : [p()] });

export const fixtures = [
  // --- Basic Markdown features -------------------------------------------
  ["headings", doc(h(1, "Leading H1"), p("Intro."), h(2, "Two"), h(3, "Three"), h(4, "Four"), h(5, "Five"), h(6, "Six"), p("End."))],
  ["leading-h2", doc(h(2, "Something"), p("Body text."))],
  ["marks-basic", doc(p(t("bold", [{ type: "bold" }]), " ", t("italic", [{ type: "italic" }]), " ", t("code", [{ type: "code" }]), " ", t("strike", [{ type: "strike" }])))],
  ["mark-link", doc(p("See ", t("Docmost", [{ type: "link", attrs: { href: "https://docmost.com" } }]), "."))],
  ["mark-underline", doc(p(t("underlined", [{ type: "underline" }])))],
  ["mark-sub-sup", doc(p("H", t("2", [{ type: "subscript" }]), "O and x", t("2", [{ type: "superscript" }])))],
  ["bullet-list", doc({ type: "bulletList", content: [li(p("one")), li(p("two")), li(p("three"))] })],
  ["ordered-list", doc({ type: "orderedList", attrs: { start: 1 }, content: [li(p("first")), li(p("second"))] })],
  ["ordered-list-start-3", doc({ type: "orderedList", attrs: { start: 3 }, content: [li(p("third")), li(p("fourth"))] })],
  ["nested-lists", doc({ type: "bulletList", content: [li(p("parent"), { type: "orderedList", attrs: { start: 1 }, content: [li(p("child a")), li(p("child b"))] }), li(p("sibling"))] })],
  ["task-list", doc({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p("done")] }, { type: "taskItem", attrs: { checked: false }, content: [p("open"), { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [p("nested")] }] }] }] })],
  ["table", doc({ type: "table", content: [
    { type: "tableRow", content: [cell("tableHeader", p("Name")), cell("tableHeader", p("Value")), cell("tableHeader", p("Notes"))] },
    { type: "tableRow", content: [cell("tableCell", p(t("bold cell", [{ type: "bold" }]))), cell("tableCell", p("1")), cell("tableCell")] },
    { type: "tableRow", content: [cell("tableCell", p("Fréjus")), cell("tableCell", p("2")), cell("tableCell", p("has | pipe"))] },
  ] })],
  ["code-block", doc({ type: "codeBlock", attrs: { language: "python" }, content: [t("def f(x):\n    return x * 2")] })],
  ["blockquote", doc({ type: "blockquote", content: [p("Quoted text.")] })],
  ["horizontal-rule", doc(p("Above"), { type: "horizontalRule" }, p("Below"))],
  ["hard-break", doc(p("line one", { type: "hardBreak" }, "line two"))],
  ["unicode-text", doc(p("Sláinte & Fréjus — “quotes” ‘apostrophe’ (brackets) 50% ✓"))],
  // Plain text that looks like Markdown, HTML, maths or links must stay plain.
  ["special-characters", doc(p("Use *stars*, _under_, [brackets](x), <b>tags</b>, &copy; and \\back, ~tilde~, a | pipe, 5 * 3 = 15"), p("Costs $5 or $10, and $x$ is not maths."))],
  ["line-start-markers", doc(p("# not a heading", { type: "hardBreak" }, "1. not a list", { type: "hardBreak" }, "- nor this", { type: "hardBreak" }, "> nor a quote", { type: "hardBreak" }, ":::info nor a callout"), p("---"), p("+ plus"))],
  ["bare-urls-and-emails", doc(p("See https://example.com/path?q=1 or www.example.org, mail ross@example.com."))],
  ["inline-code-backticks", doc(p("Run ", t("a `b` c", [{ type: "code" }]), " and ", t("<div>", [{ type: "code" }]), "."))],
  ["code-block-fence", doc({ type: "codeBlock", attrs: { language: "markdown" }, content: [t("```js\nconsole.log(1)\n```")] })],
  ["blockquote-multi", doc({ type: "blockquote", content: [p("First paragraph."), p("Second paragraph."), { type: "bulletList", content: [li(p("quoted item"))] }] })],
  ["mark-link-internal", doc(p("See ", t("another page", [{ type: "link", attrs: { href: "/s/inbox/p/mcptest-abc123", internal: true } }]), "."))],
  ["mark-link-special-href", doc(p(t("odd link", [{ type: "link", attrs: { href: "https://example.com/a path/(x)" } }])))],
  ["details-open", doc({ type: "details", attrs: { open: true }, content: [{ type: "detailsSummary", content: [t("Open summary")] }, { type: "detailsContent", content: [p("Shown body")] }] })],
  ["callout-info", doc({ type: "callout", attrs: { type: "info" }, content: [p("Note with ", t("bold", [{ type: "bold" }]), "."), p("Second line.")] })],
  ["mixed-marks", doc(p(t("bold italic", [{ type: "bold" }, { type: "italic" }]), " ", t("linked bold", [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }]), " ", t("struck code", [{ type: "strike" }, { type: "code" }])))],

  // --- Attributes on otherwise-plain nodes --------------------------------
  ["attr-text-align", doc({ type: "paragraph", attrs: { textAlign: "center" }, content: [t("centred")] })],
  ["attr-indent", doc({ type: "paragraph", attrs: { indent: 2 }, content: [t("indented")] })],
  ["attr-table-colwidth", doc({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: [240] }, content: [p("A")] }, { type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: [120] }, content: [p("B")] }] }, { type: "tableRow", content: [cell("tableCell", p("1")), cell("tableCell", p("2"))] }] })],
  ["attr-table-cell-colour", doc({ type: "table", content: [{ type: "tableRow", content: [cell("tableHeader", p("A")), cell("tableHeader", p("B"))] }, { type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 1, backgroundColor: "#fde68a", backgroundColorName: "yellow" }, content: [p("1")] }, cell("tableCell", p("2"))] }] })],

  // --- Marks not representable in plain Markdown (F3) ---------------------
  ["mark-highlight", doc(p(t("highlighted", [{ type: "highlight", attrs: { color: "#fef08a", colorName: "yellow" } }])))],
  ["mark-text-colour", doc(p(t("red text", [{ type: "textStyle", attrs: { color: "#dc2626" } }])))],
  ["mark-comment", doc(p("before ", t("commented", [{ type: "comment", attrs: { commentId: "019e0000-0000-7000-8000-000000000001", resolved: false } }]), " after"))],

  // --- Docmost blocks (F3 and the old deny-list) --------------------------
  ["tabs", doc({ type: "tabs", content: [
    { type: "tab", attrs: { id: "tab-a" }, content: [{ type: "tabLabel", content: [t("Tab A")] }, { type: "tabPanel", content: [p("Inside tab A")] }] },
    { type: "tab", attrs: { id: "tab-b" }, content: [{ type: "tabLabel", content: [t("Tab B")] }, { type: "tabPanel", content: [p("Inside tab B")] }] },
  ] })],
  ["columns", doc({ type: "columns", attrs: { layout: "two_equal", widthMode: "normal" }, content: [{ type: "column", content: [p("Left column")] }, { type: "column", content: [p("Right column")] }] })],
  ["status", doc(p("Status: ", { type: "status", attrs: { text: "Done", color: "green" } }, " and more"))],
  ["page-break", doc(p("Page one"), { type: "pageBreak" }, p("Page two"))],
  ["footnotes", { type: "doc", content: [
    p("Claim", { type: "footnoteReference", attrs: { "data-id": "fn1", referenceNumber: 1 } }, "."),
    { type: "footnotes", content: [{ type: "footnote", attrs: { id: "fn:1", "data-id": "fn1" }, content: [p("The footnote text.")] }] },
  ] }],
  ["transclusion-source", doc({ type: "transclusionSource", attrs: { id: "019e0000-0000-7000-8000-0000000000aa" }, content: [p("Synced block body")] })],
  ["transclusion-reference", doc({ type: "transclusionReference", attrs: { sourcePageId: "019e0000-0000-7000-8000-0000000000bb", transclusionId: "019e0000-0000-7000-8000-0000000000aa" } })],
  ["base-embed", doc({ type: "base", attrs: { pageId: "019e0000-0000-7000-8000-0000000000cc" } })],
  ["audio", doc({ type: "audio", attrs: { src: "/files/019e0000-0000-7000-8000-0000000000dd/clip.mp3", attachmentId: "019e0000-0000-7000-8000-0000000000dd", size: 1234 } })],
  ["pdf", doc({ type: "pdf", attrs: { src: "/files/019e0000-0000-7000-8000-0000000000ee/doc.pdf", name: "doc.pdf", attachmentId: "019e0000-0000-7000-8000-0000000000ee", size: 4321 } })],
  ["image", doc({ type: "image", attrs: { src: "https://example.com/pic.png", alt: "A picture", align: "center" } })],
  ["image-sized", doc({ type: "image", attrs: { src: "https://example.com/pic.png", alt: "Sized", width: 320, align: "left" } })],
  ["integration-card", doc({ type: "integrationCard", attrs: { url: "https://github.com/docmost/docmost", provider: "github" } })],
  ["integration-mention", doc(p("See ", { type: "integrationMention", attrs: { url: "https://github.com/docmost/docmost/issues/1", provider: "github" } }, "."))],
  ["callout", doc({ type: "callout", attrs: { type: "warning" }, content: [p("Careful.")] })],
  ["details", doc({ type: "details", attrs: { open: false }, content: [{ type: "detailsSummary", content: [t("Summary")] }, { type: "detailsContent", content: [p("Hidden body")] }] })],
  ["mention", doc(p("Ask ", { type: "mention", attrs: { id: "m1", label: "Ross", entityType: "user", entityId: "019e0000-0000-7000-8000-0000000000ff" } }, "."))],
  ["attachment", doc({ type: "attachment", attrs: { url: "/files/019e0000-0000-7000-8000-000000000101/a.zip", name: "a.zip", mime: "application/zip", size: 99, attachmentId: "019e0000-0000-7000-8000-000000000101" } })],
  ["drawio", doc({ type: "drawio", attrs: { src: "/files/019e0000-0000-7000-8000-000000000102/d.drawio.svg", title: "diagram", attachmentId: "019e0000-0000-7000-8000-000000000102" } })],
  ["excalidraw", doc({ type: "excalidraw", attrs: { src: "/files/019e0000-0000-7000-8000-000000000103/e.excalidraw.svg", title: "sketch", attachmentId: "019e0000-0000-7000-8000-000000000103" } })],
  ["embed", doc({ type: "embed", attrs: { src: "https://www.figma.com/file/abc", provider: "figma" } })],
  ["video", doc({ type: "video", attrs: { src: "/files/019e0000-0000-7000-8000-000000000104/v.mp4", attachmentId: "019e0000-0000-7000-8000-000000000104" } })],
  ["youtube", doc({ type: "youtube", attrs: { src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } })],
  ["math-inline", doc(p("Euler: ", { type: "mathInline", attrs: { text: "e^{i\\pi}+1=0" } }, "."))],
  ["math-block", doc({ type: "mathBlock", attrs: { text: "\\int_0^1 x\\,dx = \\tfrac12" } })],
  ["subpages", doc({ type: "subpages" })],
];
