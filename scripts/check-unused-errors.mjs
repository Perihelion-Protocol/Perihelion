#!/usr/bin/env node
// Fails if a custom error is declared in contracts/evm/src but never referenced
// anywhere else in that tree. An unused error inflates the ABI and the SDK's
// error-decoding table, and suggests a check that the contract does not perform.
//
// Usage: node scripts/check-unused-errors.mjs [srcDir]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const srcDir = process.argv[2] ?? "contracts/evm/src";

/** @returns {string[]} every .sol file under dir, recursively */
function solFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return solFiles(path);
    return path.endsWith(".sol") ? [path] : [];
  });
}

const files = solFiles(srcDir);
const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const declaration = /^\s*error\s+([A-Za-z_]\w*)\s*\(/gm;

let failures = 0;
let checked = 0;
for (const [file, text] of sources) {
  for (const match of text.matchAll(declaration)) {
    const name = match[1];
    checked += 1;
    const use = new RegExp(`\\b${name}\\b`, "g");
    let references = 0;
    for (const other of sources.values()) {
      references += [...other.matchAll(use)].length;
    }
    // The declaration itself is one match; anything beyond that is a use.
    if (references < 2) {
      failures += 1;
      console.error(`::error file=${file}::custom error ${name} is declared but never used`);
    }
  }
}

if (failures > 0) {
  console.error(`${failures} unused custom error(s) of ${checked} declared.`);
  process.exit(1);
}
console.log(`All ${checked} custom errors are referenced.`);
