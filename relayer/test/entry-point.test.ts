// SPDX-License-Identifier: MIT

/**
 * Issue #579: importing the package entry point must have no side effects.
 *
 * Before the split, `index.ts` was both the library entry and the CLI, so an
 * import ran `main()`: with no configuration `loadConfig` threw and the
 * handler called `process.exit(1)`, killing the importer. The import runs in
 * a child process with every PERIHELION_* variable removed, so a regression
 * fails this test instead of terminating the test runner.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BIN_NAME = "perihelion-relayer";
const EXPECTED_EXPORTS = ["Relayer", "EVMSourceWatcher", "SorobanDestinationDelivery", "messageKeyString"];

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = pathToFileURL(join(pkgRoot, "src", "index.ts")).href;

function unconfiguredEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("PERIHELION_")) env[key] = value;
  }
  return env;
}

test("importing the package with no environment configured leaves the process alive", () => {
  const script = `
    const before = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    const mod = await import(${JSON.stringify(entry)});
    // Give any stray async startup a chance to fail before we report.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    console.log(JSON.stringify({ exports: Object.keys(mod), signalListenersAdded: after - before }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: pkgRoot,
    env: unconfiguredEnv(),
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(result.status, 0, `importer exited with ${result.status}: ${result.stderr}`);
  const lines = result.stdout.trim().split("\n");
  const report = JSON.parse(lines[lines.length - 1]) as {
    exports: string[];
    signalListenersAdded: number;
  };
  assert.equal(report.signalListenersAdded, 0, "import must not install signal handlers");
  for (const name of EXPECTED_EXPORTS) {
    assert.ok(report.exports.includes(name), `missing export ${name}`);
  }
});

test("bin points at a module distinct from main, and only the CLI is marked as side-effecting", () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
    main: string;
    bin: Record<string, string>;
    sideEffects: string[] | boolean;
  };
  const bin = pkg.bin[BIN_NAME];
  assert.equal(bin, "./dist/cli.js");
  assert.notEqual(bin, pkg.main);
  assert.deepEqual(pkg.sideEffects, ["./dist/cli.js"]);
});
