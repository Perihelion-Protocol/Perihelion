#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Mutation-score gate for cargo-mutants.
//
// cargo-mutants exits non-zero on *any* surviving mutant, which would make the
// nightly job permanently red until every survivor is killed. Instead this
// script reads mutants.out/outcomes.json and fails only when the score drops
// below the recorded baseline, so the gate ratchets rather than demanding a
// large test-writing effort up front (the same approach .codecov.yml takes).
//
// It also distinguishes a *baseline* failure (cargo-mutants exit 4: the
// unmutated build or test suite failed, so no mutants were ever tested) from a
// genuine score regression, and writes a readable summary for both.
//
// Usage:
//   node scripts/check-cargo-mutants-score.mjs [path/to/mutants.out] [--min N] [--exit-code N]
//
// Score = (caught + timeout) / (caught + timeout + missed). Unviable mutants
// (ones that do not compile) are excluded, matching Stryker's definition.

import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// Recorded baseline for contracts/soroban/settlement. Raise it to the latest
// nightly score as the suite is hardened; never lower it to get a run green.
const BASELINE_MIN_SCORE = 60;

// cargo-mutants exit code for "baseline failed" (build or tests broken).
const EXIT_BASELINE_FAILED = 4;

const args = process.argv.slice(2);
let dir = "contracts/soroban/settlement/mutants.out";
let min = BASELINE_MIN_SCORE;
let exitCode = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--min") min = Number(args[++i]);
  else if (args[i] === "--exit-code") exitCode = Number(args[++i]);
  else dir = args[i];
}
if (!Number.isFinite(min)) {
  console.error("--min must be a number");
  process.exit(2);
}

const summary = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
};

// A baseline failure means the unmutated crate did not build or its tests did
// not pass, so no mutation score exists. Report it clearly instead of leaking
// a bare exit code.
if (exitCode === EXIT_BASELINE_FAILED) {
  summary(
    "cargo-mutants: BASELINE BROKEN — the unmutated build or test suite failed " +
      "(exit 4). No mutants were tested, so no score is available. Run " +
      "`cargo mutants --list` and `cargo test` in contracts/soroban/settlement " +
      "to reproduce.",
  );
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(join(dir, "outcomes.json"), "utf8"));
} catch (err) {
  summary(
    `cargo-mutants: BASELINE BROKEN — cannot read ${join(dir, "outcomes.json")} ` +
      `(${err.message}). The baseline build or tests likely failed before any ` +
      "mutant was tested.",
  );
  process.exit(1);
}

// cargo-mutants records per-run totals at the top level; fall back to
// counting per-outcome summaries if they are absent.
const count = (key, summaryName) =>
  typeof data[key] === "number"
    ? data[key]
    : (data.outcomes ?? []).filter((o) => o.summary === summaryName).length;

const caught = count("caught", "CaughtMutant");
const missed = count("missed", "MissedMutant");
const timeout = count("timeout", "Timeout");
const unviable = count("unviable", "Unviable");
const scored = caught + missed + timeout;

if (scored === 0) {
  summary(
    "cargo-mutants: BASELINE BROKEN — no viable mutants were tested. The " +
      "baseline build or tests likely failed; run `cargo mutants --list` and " +
      "`cargo test` to reproduce.",
  );
  process.exit(1);
}

const score = Math.round(((caught + timeout) / scored) * 1000) / 10;
const line =
  `cargo-mutants: caught ${caught}, missed ${missed}, timeout ${timeout}, ` +
  `unviable ${unviable} — score ${score}% (baseline ${min}%)`;
summary(line);

if (score < min) {
  console.error(`mutation score ${score}% is below the recorded baseline ${min}%`);
  process.exit(1);
}
