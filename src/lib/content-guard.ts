/**
 * Allow-list of ProseMirror content that survives a Markdown round trip
 * (read as Markdown, write back as Markdown) with no change to the stored
 * JSON. Anything not listed here, including node types Docmost adds in
 * future, makes a Markdown replace lossy, so update_page refuses it unless
 * force=true.
 *
 * The lists are not guesses: they come from tests/roundtrip.mjs run against
 * Docmost 0.97.0. Re-run the harness before adding anything.
 */

export interface TypeRule {
  /** Every attribute round-trips exactly, except those listed in defaults. */
  allAttrs?: boolean;
  /** Attributes whose value round-trips exactly, whatever it is. */
  preserved?: string[];
  /**
   * Attributes that do not survive but are only lossy when set to something
   * other than this default value.
   */
  defaults?: Record<string, unknown>;
}

// Every node Docmost writes carries dir="auto" (TextDirection), and the
// writer sets it again on every write.
const DIR = { dir: "auto" };
const BLOCK: TypeRule = { defaults: { ...DIR } };
const TEXT_BLOCK: TypeRule = { defaults: { ...DIR, indent: 0, textAlign: null } };
const CELL: TypeRule = {
  defaults: {
    ...DIR,
    colspan: 1,
    rowspan: 1,
    colwidth: null,
    backgroundColor: null,
    backgroundColorName: null,
  },
};

export const ALLOWED_NODES: Record<string, TypeRule> = {
  // A page created from Markdown gets dir="auto" on the doc itself; a
  // rewrite drops it, which is the same default.
  doc: BLOCK,
  text: {},
  paragraph: TEXT_BLOCK,
  heading: { preserved: ["level"], defaults: TEXT_BLOCK.defaults },
  blockquote: BLOCK,
  bulletList: BLOCK,
  orderedList: { preserved: ["start"], defaults: { ...DIR, type: null } },
  listItem: BLOCK,
  taskList: BLOCK,
  taskItem: { preserved: ["checked"], defaults: { ...DIR } },
  table: BLOCK,
  tableRow: BLOCK,
  tableHeader: CELL,
  tableCell: CELL,
  codeBlock: { preserved: ["language"], defaults: { ...DIR } },
  horizontalRule: BLOCK,
  hardBreak: BLOCK,
  callout: { preserved: ["type"], defaults: { ...DIR, icon: null } },
  // Docmost does not keep open=true through any rewrite (even HTML).
  details: { defaults: { ...DIR, open: false } },
  detailsSummary: BLOCK,
  detailsContent: BLOCK,
  image: {
    preserved: ["src", "alt", "width", "height", "align", "attachmentId", "size", "aspectRatio"],
    defaults: { ...DIR, placeholder: null },
  },
};

export const ALLOWED_MARKS: Record<string, TypeRule> = {
  bold: {},
  italic: {},
  code: {},
  strike: {},
  underline: {},
  subscript: {},
  superscript: {},
  link: {
    preserved: ["href", "internal"],
    defaults: {
      target: "_blank",
      rel: "noopener noreferrer nofollow",
      class: null,
      title: null,
      integrationProvider: null,
    },
  },
  highlight: { preserved: ["color", "colorName"] },
  textStyle: { preserved: ["color"] },
};

/**
 * Allow-list for a replace written as HTML (Docmost's own HTML in, HTML
 * out). Proven by tests/roundtrip.mjs in html>html mode against Docmost
 * 0.97.0: these node types keep every attribute. Not here, so blocked:
 * footnotes (Docmost's HTML export fails on them), attachment, audio, pdf
 * and embed (numeric size, width and height come back as strings), and any
 * type Docmost adds later. details loses open=true, as with Markdown.
 */
const ALL: TypeRule = { allAttrs: true };
export const HTML_ALLOWED_NODES: Record<string, TypeRule> = Object.fromEntries([
  ...[
    "doc", "text", "paragraph", "heading", "blockquote", "bulletList", "orderedList",
    "listItem", "taskList", "taskItem", "table", "tableRow", "tableHeader", "tableCell",
    "codeBlock", "horizontalRule", "hardBreak", "callout", "detailsSummary",
    "detailsContent", "image", "tabs", "tab", "tabLabel", "tabPanel", "columns",
    "column", "status", "pageBreak", "mention", "mathInline", "mathBlock", "subpages",
    "transclusionSource", "transclusionReference", "base", "drawio", "excalidraw",
    "video", "youtube", "integrationCard", "integrationMention",
  ].map((t) => [t, ALL]),
  ["details", { allAttrs: true, defaults: { open: false } }],
]);

export const HTML_ALLOWED_MARKS: Record<string, TypeRule> = Object.fromEntries(
  [
    "bold", "italic", "code", "strike", "underline", "subscript", "superscript",
    "link", "highlight", "textStyle", "comment",
  ].map((t) => [t, ALL]),
);

/** The format a replace would be written in. */
export type ContentFormat = "markdown" | "html";

const RULES: Record<ContentFormat, { nodes: Record<string, TypeRule>; marks: Record<string, TypeRule> }> = {
  markdown: { nodes: ALLOWED_NODES, marks: ALLOWED_MARKS },
  html: { nodes: HTML_ALLOWED_NODES, marks: HTML_ALLOWED_MARKS },
};

/**
 * Attributes Docmost regenerates on every write (UniqueID on headings and
 * paragraphs). They never survive a rewrite of any kind, so they are reported
 * but do not block.
 */
export const REGENERATED_ATTRS = new Set(["id"]);

export interface AttrFinding {
  type: string;
  attr: string;
  example: unknown;
  count: number;
}

export interface ContentFindings {
  /** Node types not on the allow-list, with counts. */
  nodes: Record<string, number>;
  /** Mark types not on the allow-list, with counts. */
  marks: Record<string, number>;
  /** Non-default values of attributes that a Markdown rewrite would lose. */
  attrs: AttrFinding[];
  /** How many regenerated ids (e.g. heading anchors) a rewrite would change. */
  regeneratedIds: number;
}

const isUnset = (v: unknown) => v === null || v === undefined;

// Own properties only, so a type named "constructor" or "toString" is not
// mistaken for an allowed one via the object prototype.
const ruleFor = (rules: Record<string, TypeRule>, type: unknown) =>
  typeof type === "string" && Object.hasOwn(rules, type) ? rules[type] : undefined;

function checkAttrs(
  type: string,
  rule: TypeRule,
  attrs: Record<string, unknown> | undefined,
  out: Map<string, AttrFinding>,
  counters: { regeneratedIds: number },
) {
  for (const [attr, value] of Object.entries(attrs || {})) {
    if (REGENERATED_ATTRS.has(attr)) {
      if (!isUnset(value) && value !== "") counters.regeneratedIds++;
      continue;
    }
    if (rule.preserved?.includes(attr)) continue;
    const defaults = rule.defaults || {};
    if (rule.allAttrs && !Object.hasOwn(defaults, attr)) continue;
    const lossy =
      Object.hasOwn(defaults, attr)
        ? JSON.stringify(value) !== JSON.stringify(defaults[attr]) &&
          !(isUnset(value) && isUnset(defaults[attr]))
        : !isUnset(value);
    if (!lossy) continue;
    const key = `${type}.${attr}`;
    const found = out.get(key);
    if (found) found.count++;
    else out.set(key, { type, attr, example: value, count: 1 });
  }
}

export function inspectContent(doc: any, format: ContentFormat = "markdown"): ContentFindings {
  const rules = RULES[format];
  const nodes: Record<string, number> = {};
  const marks: Record<string, number> = {};
  const attrs = new Map<string, AttrFinding>();
  const counters = { regeneratedIds: 0 };

  const flagMark = (key: string) => (marks[key] = (marks[key] || 0) + 1);

  // Anything that is not a ProseMirror document cannot be shown to be safe.
  if (!doc || typeof doc !== "object" || doc.type !== "doc") {
    nodes["(missing or invalid content)"] = 1;
    return { nodes, marks, attrs: [], regeneratedIds: 0 };
  }

  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    const rule = ruleFor(rules.nodes, node.type);
    if (rule) checkAttrs(node.type, rule, node.attrs, attrs, counters);
    else nodes[node.type] = (nodes[node.type] || 0) + 1;

    // Docmost's code mark excludes other marks, so a rewrite drops any mark
    // combined with code (links survive).
    const nodeMarks: any[] = node.marks || [];
    if (nodeMarks.some((m) => m.type === "code")) {
      for (const m of nodeMarks) {
        if (m.type === "code" || m.type === "link") continue;
        flagMark(`code+${m.type}`);
      }
    }

    for (const mark of nodeMarks) {
      const markRule = ruleFor(rules.marks, mark.type);
      if (markRule) checkAttrs(mark.type, markRule, mark.attrs, attrs, counters);
      else flagMark(mark.type);
    }
    (node.content || []).forEach(walk);
  };
  walk(doc);

  return {
    nodes,
    marks,
    attrs: [...attrs.values()],
    regeneratedIds: counters.regeneratedIds,
  };
}

/** True when a Markdown replace would lose something beyond regenerated ids. */
export function isLossy(f: ContentFindings): boolean {
  return (
    Object.keys(f.nodes).length > 0 ||
    Object.keys(f.marks).length > 0 ||
    f.attrs.length > 0
  );
}

/** One-line human summary, e.g. "tabs (2), status (1); marks: comment (3)". */
export function describeFindings(f: ContentFindings): string {
  const list = (r: Record<string, number>) =>
    Object.entries(r)
      .sort()
      .map(([t, n]) => `${t} (${n})`)
      .join(", ");
  const parts: string[] = [];
  if (Object.keys(f.nodes).length) parts.push(`blocks: ${list(f.nodes)}`);
  if (Object.keys(f.marks).length) parts.push(`marks: ${list(f.marks)}`);
  if (f.attrs.length) {
    parts.push(
      "attributes: " +
        f.attrs
          .map((a) => `${a.type}.${a.attr}=${JSON.stringify(a.example)} (${a.count})`)
          .join(", "),
    );
  }
  return parts.join("; ");
}
