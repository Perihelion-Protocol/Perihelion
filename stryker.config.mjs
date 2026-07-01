// Stryker mutation testing configuration for the Perihelion TypeScript packages.
//
// Run locally:
//   npm install --save-dev @stryker-mutator/core @stryker-mutator/typescript-checker
//   npx stryker run
//
// Or target a single package:
//   npx stryker run --mutate "sdk/src/intent.ts"
//
// See: https://stryker-mutator.io/docs/stryker-js/configuration/

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  // ─── Runner ─────────────────────────────────────────────────────────────────
  // Invoke each mutant via node:test (same runner as `npm test`).
  testRunner: "command",
  commandRunner: {
    command: "node --test --import ./node_modules/tsx/dist/esm/index.cjs sdk/test/*.test.ts relayer/test/*.test.ts solver/test/*.test.ts",
  },

  // ─── TypeScript checking ────────────────────────────────────────────────────
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.base.json",

  // ─── Mutation scope: highest-risk modules only ───────────────────────────────
  // Focus on codec/hash/verify paths in sdk/src and the relay logic in relayer/src.
  // Exclude type declarations, config glue, and generated dist/ output.
  mutate: [
    // SDK: intent construction, signing, verification, amount validation
    "sdk/src/intent.ts",
    "sdk/src/validate.ts",
    "sdk/src/units.ts",
    "sdk/src/stellar.ts",
    "sdk/src/client.ts",
    // Relayer: cross-chain message delivery logic
    "relayer/src/relayer.ts",
    "relayer/src/soroban-delivery.ts",
    "relayer/src/dead-letter.ts",
    // Solver: quote and executor logic (critical profit/fill paths)
    "solver/src/quote.ts",
    "solver/src/executor.ts",
    // Exclusions: type declarations, index barrels, config glue
    "!sdk/src/types.ts",
    "!sdk/src/errors.ts",
    "!sdk/src/index.ts",
    "!relayer/src/types.ts",
    "!relayer/src/config.ts",
    "!relayer/src/index.ts",
    "!solver/src/config.ts",
    "!solver/src/index.ts",
  ],

  // ─── Thresholds ─────────────────────────────────────────────────────────────
  // Fail CI when mutation score drops below `break` (hard gate).
  // Raise these thresholds as the test suite is hardened.
  thresholds: {
    high: 75,   // target score — aim to exceed this
    low:  60,   // warn below this
    break: 50,  // hard-fail CI below this
  },

  // ─── Reporting ──────────────────────────────────────────────────────────────
  reporters: ["html", "json", "clear-text"],
  htmlReporter: {
    fileName: "reports/mutation/index.html",
  },

  // ─── Performance ────────────────────────────────────────────────────────────
  concurrency: 4,
  timeoutMS: 30_000,
  timeoutFactor: 1.5,

  // ─── Incremental mode ───────────────────────────────────────────────────────
  // Cache results across runs so only changed files are re-mutated locally.
  incremental: true,
  incrementalFile: ".stryker-tmp/incremental.json",
};
