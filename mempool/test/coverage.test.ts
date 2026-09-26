// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("coverage infrastructure", async (t) => {
  const packageJsonPath = path.resolve("package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

  await t.test("package.json has test:coverage script", () => {
    assert(packageJson.scripts["test:coverage"]);
    assert.match(
      packageJson.scripts["test:coverage"],
      /c8/,
      "Coverage script should use c8"
    );
  });

  await t.test("c8 is in devDependencies", () => {
    assert(
      packageJson.devDependencies["c8"],
      "c8 should be in devDependencies"
    );
  });

  const codecovYmlPath = path.resolve("../.codecov.yml");
  const codecovYml = fs.readFileSync(codecovYmlPath, "utf-8");

  await t.test(".codecov.yml includes ts-mempool flag", () => {
    assert(
      codecovYml.includes("ts-mempool:"),
      ".codecov.yml should have ts-mempool flag"
    );
  });

  await t.test(".codecov.yml ts-mempool flag has correct paths", () => {
    assert(
      codecovYml.includes("- mempool/"),
      "ts-mempool flag should include mempool/ path"
    );
  });

  await t.test(".codecov.yml ts-mempool flag has carryforward enabled", () => {
    // Extract text from ts-mempool to the next flag (or end of file)
    const lines = codecovYml.split("\n");
    let inTsMempool = false;
    let hasCarryforward = false;
    for (const line of lines) {
      if (line.includes("ts-mempool:")) {
        inTsMempool = true;
      } else if (inTsMempool && line.match(/^\s{2}[a-z]/)) {
        // Found next flag at same indentation level
        break;
      }
      if (inTsMempool && line.includes("carryforward: true")) {
        hasCarryforward = true;
        break;
      }
    }
    assert(hasCarryforward, "ts-mempool should have carryforward enabled");
  });

  const workflowPath = path.resolve(
    "../.github/workflows/coverage.yml"
  );
  const workflowYml = fs.readFileSync(workflowPath, "utf-8");

  await t.test("coverage.yml workflow includes mempool in matrix", () => {
    assert(
      workflowYml.includes("mempool"),
      "coverage.yml should include mempool in the package matrix"
    );
  });

  await t.test(
    "coverage.yml uploads coverage with ts-mempool flag",
    () => {
      assert(
        workflowYml.includes("flags: ts-${{ matrix.package }}"),
        "workflow should use matrix.package for flags"
      );
    }
  );

  await t.test(
    "coverage.yml lcov path targets mempool/coverage/lcov.info",
    () => {
      assert(
        workflowYml.includes("./${{ matrix.package }}/coverage/lcov.info"),
        "workflow should upload coverage from package-specific path"
      );
    }
  );
});
