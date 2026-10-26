import { HocuspocusProvider } from "@hocuspocus/provider";
import { TiptapTransformer } from "@hocuspocus/transformer";
import * as Y from "yjs";
import WebSocket from "ws";
import { marked } from "marked";
import { generateJSON } from "@tiptap/html";
import { JSDOM } from "jsdom";
import { tiptapExtensions } from "./tiptap-extensions.js";

// Setup DOM environment for Tiptap HTML parsing in Node.js
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
global.window = dom.window as any;
global.document = dom.window.document;
// @ts-ignore
global.Element = dom.window.Element;
// @ts-ignore
global.WebSocket = WebSocket;
// Navigator is read-only in newer Node versions and already exists
// global.navigator = dom.window.navigator;

/**
 * marked renders GFM task lists as plain <ul><li><input type="checkbox">.
 * Rewrite them into the data-type markup the Tiptap TaskList/TaskItem
 * extensions parse, so checkboxes survive the HTML -> ProseMirror step.
 */
export function markTaskLists(html: string): string {
  const body = new JSDOM(`<body>${html}</body>`).window.document.body;

  // The checkbox is either the first child of the li (tight list) or the
  // first child of its leading <p> (loose list).
  const leadingCheckbox = (li: Element): Element | null => {
    let first = li.firstElementChild;
    if (first?.tagName === "P") first = first.firstElementChild;
    if (
      first?.tagName === "INPUT" &&
      first.getAttribute("type") === "checkbox" &&
      first.parentElement?.firstChild === first
    ) {
      return first;
    }
    return null;
  };

  for (const ul of Array.from(body.querySelectorAll("ul"))) {
    const items = Array.from(ul.children).filter((el) => el.tagName === "LI");
    if (items.length === 0) continue;

    // A taskList may only hold taskItems, so a list mixing checkbox and plain
    // items stays a bullet list; keep the checkbox state as literal text
    // rather than letting the parser silently drop the <input>.
    if (!items.every(leadingCheckbox)) {
      for (const li of items) {
        const input = leadingCheckbox(li);
        if (input) {
          input.replaceWith(input.hasAttribute("checked") ? "[x]" : "[ ]");
        }
      }
      continue;
    }

    ul.setAttribute("data-type", "taskList");
    for (const li of items) {
      const input = leadingCheckbox(li)!;
      li.setAttribute("data-type", "taskItem");
      li.setAttribute(
        "data-checked",
        input.hasAttribute("checked") ? "true" : "false",
      );
      const next = input.nextSibling;
      input.remove();
      if (next?.nodeType === 3) {
        next.textContent = next.textContent!.replace(/^\s+/, "");
      }
    }
  }

  return body.innerHTML;
}

export async function updatePageContentRealtime(
  pageId: string,
  markdownContent: string,
  collabToken: string,
  baseUrl: string,
): Promise<void> {
  console.error(`Starting realtime update for page ${pageId}`);
  console.error(
    `Token prefix: ${collabToken ? collabToken.substring(0, 5) : "NONE"}...`,
  );

  // 1. Convert Markdown to HTML
  const html = markTaskLists(await marked.parse(markdownContent));

  // 2. Convert HTML to ProseMirror JSON
  const tiptapJson = generateJSON(html, tiptapExtensions);

  // 3. Setup Hocuspocus Provider
  const ydoc = new Y.Doc();

  // Construct WebSocket URL
  // Replace protocol
  let wsUrl = baseUrl.replace(/^http/, "ws");

  try {
    const urlObj = new URL(wsUrl);
    // Remove /api suffix if present, as the websocket is mounted on root /collab
    if (urlObj.pathname.endsWith("/api") || urlObj.pathname.endsWith("/api/")) {
      urlObj.pathname = urlObj.pathname.replace(/\/api\/?$/, "");
    }

    // Set correct path to /collab
    urlObj.pathname = urlObj.pathname.replace(/\/$/, "") + "/collab";

    wsUrl = urlObj.toString();
  } catch (e) {
    // Fallback if URL parsing fails
    if (!wsUrl.endsWith("/collab")) {
      wsUrl = wsUrl.replace(/\/$/, "") + "/collab";
    }
  }

  console.error(`Connecting to WebSocket: ${wsUrl}`);

  return new Promise<void>((resolve, reject) => {
    // Safety timeout
    const timer = setTimeout(() => {
      if (provider) provider.destroy();
      reject(new Error("Connection timeout to collaboration server"));
    }, 25000);

    const provider = new HocuspocusProvider({
      url: wsUrl,
      name: `page.${pageId}`,
      document: ydoc,
      token: collabToken,
      // @ts-ignore - Required for Node.js environment
      WebSocketPolyfill: WebSocket as any,
      onConnect: () => console.error("WS Connect"),
      onDisconnect: (data) => console.error("WS Disconnect"),
      onClose: (data) => console.error("WS Close"),
      onSynced: () => {
        console.error("Connected and synced!");
        try {
          // Prepare the new content in a separate doc
          const tempDoc = TiptapTransformer.toYdoc(
            tiptapJson,
            "default",
            tiptapExtensions,
          );

          // Apply update
          ydoc.transact(() => {
            const fragment = ydoc.getXmlFragment("default");
            // 1. Clear existing content
            if (fragment.length > 0) {
              fragment.delete(0, fragment.length);
            }

            // 2. Apply new content from tempDoc
            // Note: applyUpdate adds content. Since we cleared, it should effectively replace.
            // However, applyUpdate merges structures based on IDs. tempDoc has new IDs.
            const update = Y.encodeStateAsUpdate(tempDoc);
            Y.applyUpdate(ydoc, update);
          });

          console.error(
            "Content replaced. Returning success to user immediately (Background persistence)...",
          );

          // Clear safety timeout as we are successful
          clearTimeout(timer);

          // Resolve immediately so the user doesn't have to wait
          resolve();

          // Keep connection open in background for save/sync (Docmost has 10s debounce)
          // The node process will keep running this timeout even after the tool returns
          setTimeout(() => {
            try {
              console.error(`Closing background connection for page ${pageId}`);
              provider.destroy();
            } catch (err) {}
          }, 15000);
        } catch (e) {
          clearTimeout(timer);
          provider.destroy();
          reject(e);
        }
      },
      onAuthenticationFailed: () => {
        clearTimeout(timer);
        provider.destroy();
        reject(new Error("Authentication failed for collaboration connection"));
      },
    });
  });
}
