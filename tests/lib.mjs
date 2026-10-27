// Shared helpers for the live harness scripts. Talks to a real Docmost
// instance; credentials come from DOCMOST_API_URL / DOCMOST_EMAIL /
// DOCMOST_PASSWORD and are never printed.
import axios from "axios";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TEST_SPACE_ID =
  process.env.MCPTEST_SPACE_ID || "019e27dc-fa6b-76b8-a6fd-4f81cb8cad8b"; // Inbox
export const PREFIX = "MCPTEST";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Permanently delete the given test pages if the run is interrupted
 * (Ctrl-C, docker stop), so no MCPTEST pages are left behind.
 */
export function cleanupOnInterrupt(api, created) {
  const handler = async (signal) => {
    console.log(`${signal}: deleting ${created.length} test pages before exit`);
    for (const id of created) {
      await api.post("/pages/delete", { pageId: id, permanentlyDelete: true }).catch(() => {});
    }
    process.exit(130);
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
}

export async function apiClient() {
  const base = process.env.DOCMOST_API_URL;
  const login = await axios.post(`${base}/auth/login`, {
    email: process.env.DOCMOST_EMAIL,
    password: process.env.DOCMOST_PASSWORD,
  });
  const token = login.headers["set-cookie"]
    .find((c) => c.startsWith("authToken="))
    .split(";")[0]
    .split("=")[1];
  const http = axios.create({
    baseURL: base,
    headers: { Authorization: `Bearer ${token}` },
  });
  const post = async (path, body) => {
    try {
      return (await http.post(path, body)).data.data;
    } catch (err) {
      const msg = err.response?.data?.message ?? err.message;
      throw new Error(`${path}: ${Array.isArray(msg) ? msg.join("; ") : msg}`);
    }
  };
  return { post, token };
}

/** Minimal MCP client over stdio against build/index.js. */
export function mcpServer(env = {}) {
  const proc = spawn("node", [join(ROOT, "build/index.js")], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const strayStdout = [];
  let buf = "";
  let nextId = 1;
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        strayStdout.push(line);
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  proc.stderr.on("data", () => {}); // diagnostics; not needed here
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const ready = (async () => {
    await send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "harness", version: "1" },
    });
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
  })();
  return {
    strayStdout,
    async listTools() {
      await ready;
      return (await send("tools/list", {})).result.tools;
    },
    /** Returns { ok, text, json } for a tool call. */
    async call(name, args) {
      await ready;
      const msg = await send("tools/call", { name, arguments: args });
      if (msg.error) return { ok: false, text: msg.error.message };
      const text = msg.result.content?.[0]?.text ?? "";
      let json;
      try {
        json = JSON.parse(text);
      } catch {}
      return { ok: !msg.result.isError, text, json };
    },
    close: () => proc.kill(),
  };
}

/** Wait until the stored JSON content satisfies pred (writes land via Yjs). */
export async function waitForContent(api, pageId, pred, timeoutMs = 20000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = (await api.post("/pages/info", { pageId })).content;
    if (pred(last)) return last;
    await sleep(400);
  }
  throw new Error(`Timed out waiting for page ${pageId} content to settle`);
}

const SENTINEL_TEXT = (n) => `MCPTEST-SENTINEL-${n}`;
let sentinelN = 0;
const isSentinel = (doc, n) =>
  doc?.content?.length === 1 &&
  doc.content[0].content?.[0]?.text === SENTINEL_TEXT(n);

/**
 * Run a write and return the content once it has landed. A sentinel is
 * written and observed first, so "settled" is unambiguous even when the
 * write produces exactly what was there before.
 */
export async function settledWrite(api, pageId, write) {
  const n = ++sentinelN;
  await api.post("/pages/update", {
    pageId,
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: SENTINEL_TEXT(n) }] }],
    },
    format: "json",
    operation: "replace",
  });
  await waitForContent(api, pageId, (c) => isSentinel(c, n));
  await write();
  // Let any trailing store finish, then require two identical reads.
  const first = await waitForContent(api, pageId, (c) => !isSentinel(c, n));
  await sleep(800);
  const second = (await api.post("/pages/info", { pageId })).content;
  return JSON.stringify(first) === JSON.stringify(second)
    ? second
    : waitForContent(api, pageId, () => true);
}

/** Strip regenerated ids so diffs show real changes; count what was stripped. */
export function normalize(doc) {
  let ids = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const key of Object.keys(node).sort()) {
      if (key === "attrs" && node.attrs && typeof node.attrs === "object") {
        const attrs = {};
        for (const a of Object.keys(node.attrs).sort()) {
          if (a === "id" && ["heading", "paragraph", "transclusionSource"].includes(node.type)) {
            ids++;
            continue;
          }
          attrs[a] = node.attrs[a];
        }
        out.attrs = attrs;
      } else out[key] = walk(node[key]);
    }
    return out;
  };
  return { doc: walk(doc), ids };
}

/** Paths where two normalized docs differ (first `max`). */
export function diff(a, b, path = "$", out = [], max = 8) {
  if (out.length >= max) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: ${short(a)} -> ${short(b)}`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diff(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`, out, max);
  return out;
}

const short = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 90 ? s.slice(0, 87) + "..." : s;
};

/** Every node, mark and attribute name present in a doc. */
export function typesIn(doc) {
  const nodes = new Set();
  const marks = new Set();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type) nodes.add(n.type);
    for (const m of n.marks || []) marks.add(m.type);
    (n.content || []).forEach(walk);
  };
  walk(doc);
  return { nodes, marks };
}
