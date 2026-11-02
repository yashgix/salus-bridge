// `node artifact/build.ts`: refreshes the data embedded in artifact/index.html from the saved results, so the page
// shows exactly docs/results/bench-seed7-runs30.json and docs/results/traces-seed7-run1.json. Offline; no packages.
import { readFileSync, writeFileSync } from "node:fs";

const MACHINE = "Apple M4 Pro"; // where docs/results/bench-seed7-runs30.json was produced (not recorded in the file)
const page = "artifact/index.html";
const bench = JSON.parse(readFileSync("docs/results/bench-seed7-runs30.json", "utf8"));
const traces = JSON.parse(readFileSync("docs/results/traces-seed7-run1.json", "utf8"));
const data = JSON.stringify({ bench: { ...bench, machine: MACHINE }, traces: traces.traces })
  .replace(/</g, "\\u003c"); // safe inside a <script> element

const html = readFileSync(page, "utf8");
const re = /(<script type="application\/json" id="data">)[\s\S]*?(<\/script>)/;
if (!re.test(html)) {
  process.stderr.write("artifact/index.html: data block not found\n");
  process.exit(1);
}
writeFileSync(page, html.replace(re, (_m, open: string, close: string) => open + data + close));
process.stdout.write(`embedded ${traces.traces.length} traces and ${bench.scenarios.length} benchmark rows into ${page}\n`);
