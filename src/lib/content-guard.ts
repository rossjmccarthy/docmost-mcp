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
  doc: {},
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
    const lossy =
      attr in defaults
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

export function inspectContent(doc: any): ContentFindings {
  const nodes: Record<string, number> = {};
  const marks: Record<string, number> = {};
  const attrs = new Map<string, AttrFinding>();
  const counters = { regeneratedIds: 0 };

  const flagMark = (key: string) => (marks[key] = (marks[key] || 0) + 1);

  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    const rule = ALLOWED_NODES[node.type];
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
      const markRule = ALLOWED_MARKS[mark.type];
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
