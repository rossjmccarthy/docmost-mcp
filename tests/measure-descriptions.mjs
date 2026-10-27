// Offline: how much text the tool list costs an agent. Prints the total
// characters of tool descriptions, of parameter descriptions, and the size
// of the whole tools/list result.
//
// Usage: npm run build && node tests/measure-descriptions.mjs [--per-tool]
import { mcpServer } from "./lib.mjs";

const server = mcpServer({ DOCMOST_API_URL: "http://127.0.0.1:9/api", DOCMOST_EMAIL: "x", DOCMOST_PASSWORD: "x" });
const tools = await server.listTools();
server.close();

let toolChars = 0;
let paramChars = 0;
const rows = [];
for (const t of tools) {
  const d = (t.description || "").length;
  let p = 0;
  for (const prop of Object.values(t.inputSchema?.properties || {})) p += (prop.description || "").length;
  toolChars += d;
  paramChars += p;
  rows.push([t.name, d, p]);
}
if (process.argv.includes("--per-tool")) {
  for (const [name, d, p] of rows.sort((a, b) => b[1] + b[2] - a[1] - a[2])) console.log(`${name.padEnd(22)} ${String(d).padStart(4)} + ${String(p).padStart(4)}`);
}
console.log(`tools: ${tools.length}`);
console.log(`tool descriptions: ${toolChars} chars`);
console.log(`parameter descriptions: ${paramChars} chars`);
console.log(`descriptions total: ${toolChars + paramChars} chars`);
console.log(`whole tools/list result: ${JSON.stringify(tools).length} chars`);
