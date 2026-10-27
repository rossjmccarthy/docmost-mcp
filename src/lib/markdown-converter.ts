/**
 * Escape plain text so Docmost's Markdown parser (marked, GFM, with its
 * callout and math extensions) reads it back as the same literal text:
 * Markdown punctuation, HTML-looking text, entities, $ (inline math),
 * bare URLs or e-mail addresses (GFM autolinks), and ":::" (the callout
 * extension splits text at any ":::", so it is written as an entity).
 */
function escapeText(text: string): string {
  return text
    .replace(/[\\`*_[\]<>~$]/g, "\\$&")
    .replace(/&(?=#?[a-zA-Z0-9]+;)/g, "&amp;")
    .replace(/(https?|ftp|mailto):/gi, "$1\\:")
    .replace(/\bwww\./gi, "www\\.")
    .replace(/@/g, "\\@")
    .replace(/:::/g, "&#58;::");
}

/** Escape a character that would start a block (heading, quote, list...) at a line start. */
function escapeLineStarts(text: string): string {
  return text.replace(
    /^([ \t]*)([#>+=-]|\d+(?=[.)]))/gm,
    (_m, space, marker) =>
      /^\d/.test(marker) ? `${space}${marker}\\` : `${space}\\${marker}`,
  );
}

/** Wrap inline code in enough backticks to hold any backticks inside it. */
function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const attr = (value: unknown) =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Convert ProseMirror/TipTap JSON content to Markdown
 * Supports all Docmost-specific node types and extensions
 */
export function convertProseMirrorToMarkdown(content: any): string {
  if (!content || !content.content) return "";

  const processNode = (node: any): string => {
    const type = node.type;
    const nodeContent = node.content || [];

    switch (type) {
      case "doc":
        return nodeContent.map(processNode).join("\n\n");

      case "paragraph":
        const text = escapeLineStarts(nodeContent.map(processNode).join(""));
        const align = node.attrs?.textAlign;
        if (align && align !== "left") {
          return `<div align="${align}">${text}</div>`;
        }
        return text || "";

      case "heading":
        const level = node.attrs?.level || 1;
        const headingText = nodeContent.map(processNode).join("");
        return "#".repeat(level) + " " + headingText;

      case "text":
        const isCode = (node.marks || []).some((m: any) => m.type === "code");
        let textContent = isCode ? node.text || "" : escapeText(node.text || "");
        // Apply marks (bold, italic, code, etc.)
        if (node.marks) {
          for (const mark of node.marks) {
            switch (mark.type) {
              case "bold":
                textContent = `**${textContent}**`;
                break;
              case "italic":
                textContent = `*${textContent}*`;
                break;
              case "code":
                textContent = inlineCode(textContent);
                break;
              case "link": {
                const href = mark.attrs?.href || "";
                // Internal page links and integration links carry attributes
                // plain Markdown cannot; Docmost parses them back from HTML.
                // So do destinations with spaces or brackets, which Markdown
                // would percent-encode.
                if (
                  mark.attrs?.internal ||
                  mark.attrs?.integrationProvider ||
                  /[\s()<>]/.test(href)
                ) {
                  const extra =
                    (mark.attrs.internal ? ` data-internal="true"` : "") +
                    (mark.attrs.integrationProvider
                      ? ` data-integration-provider="${attr(mark.attrs.integrationProvider)}"`
                      : "");
                  textContent = `<a href="${attr(href)}"${extra}>${textContent}</a>`;
                } else {
                  textContent = `[${textContent}](${href})`;
                }
                break;
              }
              case "strike":
                textContent = `~~${textContent}~~`;
                break;
              case "underline":
                textContent = `<u>${textContent}</u>`;
                break;
              case "subscript":
                textContent = `<sub>${textContent}</sub>`;
                break;
              case "superscript":
                textContent = `<sup>${textContent}</sup>`;
                break;
              case "highlight": {
                const color = mark.attrs?.color || "yellow";
                const name = mark.attrs?.colorName
                  ? ` data-highlight-color-name="${attr(mark.attrs.colorName)}"`
                  : "";
                textContent = `<mark data-color="${attr(color)}"${name} style="background-color: ${attr(color)}">${textContent}</mark>`;
                break;
              }
              case "textStyle":
                if (mark.attrs?.color) {
                  textContent = `<span style="color: ${mark.attrs.color}">${textContent}</span>`;
                }
                break;
            }
          }
        }
        return textContent;

      case "codeBlock":
        const language = node.attrs?.language || "";
        const code = nodeContent.map((n: any) => n.text || "").join("");
        const longest = Math.max(0, ...(code.match(/`{3,}/g) || []).map((r: string) => r.length));
        const fence = "`".repeat(Math.max(3, longest + 1));
        return fence + language + "\n" + code + "\n" + fence;

      case "bulletList":
        return nodeContent
          .map((item: any) => processListItem(item, "-"))
          .join("\n");

      case "orderedList": {
        const start = Number.isInteger(node.attrs?.start) ? node.attrs.start : 1;
        return nodeContent
          .map((item: any, index: number) =>
            processListItem(item, `${start + index}.`),
          )
          .join("\n");
      }

      case "taskList":
        return nodeContent.map((item: any) => processTaskItem(item)).join("\n");

      case "taskItem":
        const checked = node.attrs?.checked || false;
        const checkbox = checked ? "[x]" : "[ ]";
        return `- ${checkbox} ${nodeContent.map(processNode).join("\n")}`;

      case "listItem":
        return nodeContent.map(processNode).join("\n");

      case "blockquote":
        return nodeContent
          .map(processNode)
          .join("\n\n")
          .split("\n")
          .map((line: string) => (line ? `> ${line}` : ">"))
          .join("\n");

      case "horizontalRule":
        return "---";

      case "hardBreak":
        return "\n";

      case "image": {
        // Emitted as Docmost's own <img> markup so size, alignment and the
        // attachment reference survive a write back.
        const a = node.attrs || {};
        const parts = [
          ["src", a.src],
          ["alt", a.alt],
          ["width", a.width],
          ["height", a.height],
          ["data-align", a.align],
          ["data-attachment-id", a.attachmentId],
          ["data-size", a.size],
          ["data-aspect-ratio", a.aspectRatio],
        ]
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `${k}="${attr(v)}"`);
        return `<img ${parts.join(" ")}>`;
      }

      case "video":
        const videoSrc = node.attrs?.src || "";
        return `🎥 [Video](${videoSrc})`;

      case "youtube":
        const youtubeUrl = node.attrs?.src || "";
        return `📺 [YouTube Video](${youtubeUrl})`;

      case "table":
        return processTable(nodeContent);

      case "tableRow":
        return "| " + nodeContent.map(processNode).join(" | ") + " |";

      case "tableCell":
      case "tableHeader":
        return nodeContent.map(processNode).join("");

      case "callout":
        const calloutType = node.attrs?.type || "info";
        const calloutContent = nodeContent.map(processNode).join("\n\n");
        return `:::${calloutType.toLowerCase()}\n${calloutContent}\n:::`;

      case "details":
        return nodeContent.map(processNode).join("\n");

      case "detailsSummary":
        const summaryText = nodeContent.map(processNode).join("");
        return `<details>\n<summary>${summaryText}</summary>\n`;

      case "detailsContent":
        const detailsText = nodeContent.map(processNode).join("\n");
        return `${detailsText}\n</details>`;

      case "mathInline":
        const inlineMath = node.attrs?.text || "";
        return `$${inlineMath}$`;

      case "mathBlock":
        const blockMath = node.attrs?.text || "";
        return `$$\n${blockMath}\n$$`;

      case "mention":
        const mentionLabel = node.attrs?.label || node.attrs?.id || "";
        return `@${mentionLabel}`;

      case "attachment":
        const attachmentName = node.attrs?.fileName || "attachment";
        const attachmentUrl = node.attrs?.src || "";
        return `📎 [${attachmentName}](${attachmentUrl})`;

      case "drawio":
        return `📊 [Draw.io Diagram]`;

      case "excalidraw":
        return `✏️ [Excalidraw Drawing]`;

      case "embed":
        const embedUrl = node.attrs?.src || "";
        return `🔗 [Embedded Content](${embedUrl})`;

      case "subpages":
        return "{{SUBPAGES}}";

      default:
        // Fallback: process children
        return nodeContent.map(processNode).join("");
    }
  };

  // Indent every line after the marker so nested blocks (sub-lists, extra
  // paragraphs) stay inside the list item.
  const processListItem = (item: any, prefix: string): string => {
    const itemContent = item.content || [];
    const indent = " ".repeat(prefix.length + 1);
    return itemContent
      .map(processNode)
      .join("\n")
      .split("\n")
      .map((line: string, i: number) =>
        i === 0 ? `${prefix} ${line}` : line ? `${indent}${line}` : line,
      )
      .join("\n");
  };

  // GFM table cells are single-line: escape pipes and turn line breaks
  // (hardBreak or multiple paragraphs) into <br>.
  const processTableCell = (cell: any): string =>
    (cell.content || [])
      .map(processNode)
      .join("\n")
      .trim()
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, "<br>");

  const processTable = (rows: any[]): string => {
    const cells = rows.map((row: any) =>
      (row.content || []).map(processTableCell),
    );
    if (cells.length === 0) return "";
    const columns = Math.max(1, ...cells.map((r: string[]) => r.length));
    const line = (r: string[]) =>
      "| " +
      [...r, ...Array(columns - r.length).fill("")].join(" | ") +
      " |";
    const separator = "|" + " --- |".repeat(columns);
    return [line(cells[0]), separator, ...cells.slice(1).map(line)].join("\n");
  };

  const processTaskItem = (item: any): string => {
    const checked = item.attrs?.checked || false;
    const checkbox = checked ? "[x]" : "[ ]";
    return processListItem(item, "-").replace(/^- /, `- ${checkbox} `);
  };

  return processNode(content).trim();
}
