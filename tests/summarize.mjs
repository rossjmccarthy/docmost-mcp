// Compact report from tests/roundtrip-results.json.
// Usage: node tests/summarize.mjs [--detail fixture ...]
import { readFileSync } from "fs";
import { join } from "path";
import { ROOT } from "./lib.mjs";

const results = JSON.parse(readFileSync(join(ROOT, "tests/roundtrip-results.json"), "utf-8"));
const args = process.argv.slice(2);
const detail = args[0] === "--detail" ? args.slice(1) : null;
const modes = ["fork>native", "native>native", "html>html"];

const cell = (r) => {
  if (!r) return "-";
  if (r.error) return "ERR";
  if (r.exact) return r.idsKept ? "ok" : "ok*";
  const lost = [...(r.lost || []), ...(r.lostMarks || []).map((m) => "~" + m)];
  return lost.length ? "LOST:" + lost.join("+") : "DIFF";
};

if (!detail) {
  console.log(["fixture", ...modes].join(" | "));
  for (const row of results) {
    if (row.error) { console.log(`${row.name} | FIXTURE ERROR: ${row.error}`); continue; }
    console.log([row.name, ...modes.map((m) => cell(row.modes[m]))].join(" | "));
  }
  console.log("(ok* = exact apart from regenerated heading/paragraph ids)");
} else {
  for (const row of results.filter((r) => detail.includes(r.name))) {
    console.log(`=== ${row.name}`);
    for (const m of modes) {
      const r = row.modes[m];
      if (!r) continue;
      console.log(`-- ${m}: ${cell(r)}${r.error ? " " + r.error : ""}`);
      if (r.text !== undefined) console.log(`   read: ${JSON.stringify(r.text).slice(0, 300)}`);
      for (const d of r.diff || []) console.log(`   ${d}`);
    }
  }
}
