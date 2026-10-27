// Derive an allow-list proposal from tests/roundtrip-results.json for one
// mode: node and mark types that appear only in fixtures that round-tripped
// exactly, plus the attribute values seen on them (the defaults).
// Usage: node tests/derive-allowlist.mjs [mode]   (default fork>native)
import { readFileSync } from "fs";
import { join } from "path";
import { ROOT } from "./lib.mjs";

const mode = process.argv[2] || "fork>native";
const results = JSON.parse(readFileSync(join(ROOT, "tests/roundtrip-results.json"), "utf-8"));

const good = new Map(); // type -> Map(attr -> Set(values))
const bad = new Set();
const record = (doc, exact) => {
  const walk = (n, isMark) => {
    if (!n || typeof n !== "object") return;
    const key = (isMark ? "mark:" : "") + n.type;
    if (!exact) bad.add(key);
    else {
      if (!good.has(key)) good.set(key, new Map());
      for (const [a, v] of Object.entries(n.attrs || {})) {
        const m = good.get(key);
        if (!m.has(a)) m.set(a, new Set());
        m.get(a).add(JSON.stringify(v));
      }
    }
    for (const m of n.marks || []) walk(m, true);
    (n.content || []).forEach((c) => walk(c, false));
  };
  walk(doc, false);
};
for (const row of results) {
  if (!row.baseline || !row.modes[mode]) continue;
  record(row.baseline, !!row.modes[mode].exact);
}
console.log(`mode ${mode}`);
for (const [type, attrs] of [...good].sort()) {
  const flag = bad.has(type) ? "  (also in a failing fixture)" : "";
  const list = [...attrs].map(([a, vs]) => `${a}=${[...vs].join("|")}`).join(", ");
  console.log(`ok   ${type}${flag}  ${list}`);
}
console.log("only in failing fixtures: " + [...bad].filter((t) => !good.has(t)).sort().join(", "));
