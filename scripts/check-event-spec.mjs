#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Checks the "Event Shape Specification" table in the PerihelionEscrow NatSpec
// header against the compiled ABI, so the documented event surface cannot drift
// from the contract (indexers and the relayer's log decoder are built from it).
//
// For every event in the ABI there must be exactly one table row, with the same
// indexed (topic) and non-indexed (data) parameter names in the same order. A row
// for an event that is not in the ABI also fails.
//
// Usage (after `forge build` in contracts/evm):
//   node scripts/check-event-spec.mjs
//   node scripts/check-event-spec.mjs --artifact <path>   # use another artefact

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "contracts/evm/src/PerihelionEscrow.sol");

const args = process.argv.slice(2);
const artifactIdx = args.indexOf("--artifact");
const artifact =
  artifactIdx >= 0
    ? args[artifactIdx + 1]
    : join(ROOT, "contracts/evm/out/PerihelionEscrow.sol/PerihelionEscrow.json");

let abi;
try {
  abi = JSON.parse(readFileSync(artifact, "utf8")).abi;
} catch (err) {
  console.error(`cannot read ABI from ${artifact}: ${err.message}`);
  console.error("Build the contract first: (cd contracts/evm && forge build)");
  process.exit(1);
}

// --- Parse the spec table from the NatSpec header ---------------------------

const lines = readFileSync(SOURCE, "utf8").split("\n");
const headerIdx = lines.findIndex((l) => /^\/\/\/\s*\|\s*Event\s*\|\s*Topics\s*\|/.test(l));
if (headerIdx < 0) {
  console.error(`::error::${relative(ROOT, SOURCE)}: event spec table header not found`);
  process.exit(1);
}
const endIdx = lines.findIndex((l, i) => i > headerIdx && /^contract PerihelionEscrow\b/.test(l));
if (endIdx < 0) {
  console.error(`::error::${relative(ROOT, SOURCE)}: contract declaration not found after the table`);
  process.exit(1);
}

const cellList = (cell) => {
  const t = cell.trim();
  if (t === "-" || t === "") return [];
  return t.split(",").map((s) => s.trim());
};

const rows = new Map(); // event name -> { topics, data, line }
const errors = [];
for (let i = headerIdx + 1; i < endIdx; i++) {
  const line = lines[i];
  if (!line.startsWith("///")) continue;
  const body = line.replace(/^\/\/\/\s*/, "");
  if (!body.startsWith("|")) continue;
  const cells = body.split("|").slice(1, -1).map((c) => c.trim());
  if (cells.length < 3) continue;
  if (cells.every((c) => /^-+$/.test(c) || c === "")) continue; // separator row
  if (cells[0] === "Event") continue;
  const [name, topics, data] = cells;
  if (rows.has(name)) {
    errors.push(`event "${name}" has more than one spec row (lines ${rows.get(name).line} and ${i + 1})`);
    continue;
  }
  rows.set(name, { topics: cellList(topics), data: cellList(data), line: i + 1 });
}

// --- Compare against the ABI ------------------------------------------------

const abiEvents = abi.filter((e) => e.type === "event");
const abiNames = new Set(abiEvents.map((e) => e.name));

for (const e of abiEvents) {
  const row = rows.get(e.name);
  if (!row) {
    errors.push(`event "${e.name}" is in the ABI but has no row in the spec table`);
    continue;
  }
  const topics = e.inputs.filter((p) => p.indexed).map((p) => p.name);
  const data = e.inputs.filter((p) => !p.indexed).map((p) => p.name);
  if (topics.join(",") !== row.topics.join(",")) {
    errors.push(
      `event "${e.name}" (spec line ${row.line}): topics are [${topics.join(", ")}] in the ABI but [${row.topics.join(", ")}] in the table`,
    );
  }
  if (data.join(",") !== row.data.join(",")) {
    errors.push(
      `event "${e.name}" (spec line ${row.line}): data are [${data.join(", ")}] in the ABI but [${row.data.join(", ")}] in the table`,
    );
  }
}

for (const [name, row] of rows) {
  if (!abiNames.has(name)) {
    errors.push(`spec row "${name}" (line ${row.line}) does not match any event in the ABI`);
  }
}

if (errors.length > 0) {
  for (const msg of errors) console.error(`::error::${msg}`);
  console.error(`\n${errors.length} event spec problem(s). Update the table in ${relative(ROOT, SOURCE)}.`);
  process.exit(1);
}
console.log(`ok event spec matches the ABI (${abiEvents.length} events)`);
