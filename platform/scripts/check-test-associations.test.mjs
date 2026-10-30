import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { inventory, isTest } from "./check-test-associations.mjs";

function associate(file, files) {
  const row = inventory(new Set([...files, file])).rows.find(
    (row) => row.test === file,
  );
  return !row || row.kind === "unassociated" ? null : row;
}

const examples = [
  [
    "platform/backend/src/models/limit.test.ts",
    "platform/backend/src/models/limit.ts",
  ],
  [
    "platform/backend/src/models/limit.unit.test.ts",
    "platform/backend/src/models/limit.ts",
  ],
  [
    "platform/backend/src/models/limit.rollback.test.ts",
    "platform/backend/src/models/limit.ts",
  ],
  [
    "platform/frontend/src/page.client.streaming.test.tsx",
    "platform/frontend/src/page.client.tsx",
  ],
  [
    "platform/backend/src/anthropic-billing.test.ts",
    "platform/backend/src/anthropic.ts",
  ],
  [
    "platform/backend/src/users/create.users.route.test.ts",
    "platform/backend/src/users/users.routes.ts",
  ],
  [
    "platform/backend/src/rum/ingest.rum.route.ee.test.ts",
    "platform/backend/src/rum/rum.routes.ee.ts",
  ],
  [
    "platform/frontend/src/__tests__/widget.test.tsx",
    "platform/frontend/src/widget.tsx",
  ],
  [
    "platform/backend/src/tokenizers/tokenizers.unit.test.ts",
    "platform/backend/src/tokenizers/index.ts",
  ],
  [
    "platform/backend/src/proxy/adapters.test.ts",
    "platform/backend/src/proxy/adapters/index.ts",
  ],
  [
    "platform/backend/src/database/migrations/1234_fix.unit.test.ts",
    "platform/backend/src/database/migrations/1234_fix.sql",
  ],
];
for (const [file, target] of examples)
  test(`associate ${file}`, () => {
    assert.deepEqual(associate(file, new Set([file, target])).targets, [
      target,
    ]);
  });
for (const file of [
  "platform/backend/src/routes/personal-key-attribution.test.ts",
  "platform/backend/src/routes/personal-key-attribution.integration.test.ts",
  "platform/backend/src/routes/limitless.test.ts",
  "platform/backend/src/routes/limit-integration.test.ts",
  "platform/backend/src/routes/__tests__/random.test.ts",
])
  test(`reject unrelated ${file}`, () => {
    assert.equal(
      associate(
        file,
        new Set([
          file,
          "platform/backend/src/models/limit.ts",
          "platform/backend/src/routes/openai.ts",
        ]),
      ),
      null,
    );
  });
test("prefer full implementation basename over a shorter prefix", () => {
  assert.deepEqual(
    associate(
      "platform/frontend/src/page.client.streaming.test.tsx",
      new Set([
        "platform/frontend/src/page.tsx",
        "platform/frontend/src/page.client.tsx",
      ]),
    ).targets,
    ["platform/frontend/src/page.client.tsx"],
  );
});
test("test files, declarations, generated files and fixture data cannot be owners", () => {
  for (const candidate of [
    "platform/backend/src/foo.test.ts",
    "platform/backend/src/foo.d.ts",
    "platform/backend/src/foo.gen.ts",
    "platform/backend/src/foo.test-data.ts",
  ]) {
    assert.equal(
      associate(
        candidate.replace(/\.(test|d|gen|test-data)\.ts$/, ".$1.more.test.ts"),
        new Set([candidate]),
      ),
      null,
    );
  }
});
test("scope includes specs; excludes both Playwright locations and generated/vendor/output files", () => {
  assert.equal(isTest("platform/backend/src/thing.spec.ts"), true);
  assert.equal(isTest("platform/backend/scripts/check.test.mjs"), true);
  for (const file of [
    "platform/e2e-tests/tests/floating.spec.ts",
    "platform/frontend/tests-integration/floating.spec.ts",
    "platform/frontend/src/__generated__/floating.test.ts",
    "platform/backend/vendor/floating.test.ts",
    "platform/shared/dist/floating.test.ts",
  ])
    assert.equal(isTest(file), false);
});
test("explicit association is exact and validates owners, reasons and stale entries", () => {
  const file = "platform/backend/src/routes/limit-integration.test.ts";
  const target = "platform/backend/src/routes/openai.ts";
  const association = {
    [file]: {
      targets: [target],
      reason: "Proxy route and limit persistence integration",
    },
  };
  assert.equal(
    inventory(new Set([file, target]), association).errors.length,
    0,
  );
  assert.equal(
    inventory(new Set([file, target]), association).rows[0].kind,
    "explicit",
  );
  assert.equal(
    inventory(
      new Set([file, target, file.replace("limit-", "other-")]),
      association,
    ).rows.filter((r) => r.kind === "unassociated").length,
    1,
  );
  assert.ok(inventory(new Set([file]), association).errors.length);
  assert.ok(inventory(new Set([target]), association).errors.length);
  assert.ok(
    inventory(new Set([file, target]), { [file]: { targets: [target] } }).errors
      .length,
  );
  assert.ok(
    inventory(new Set([file, target]), {
      [file]: {
        targets: ["platform/backend/src/routes/*.ts"],
        reason: "broad",
      },
    }).errors.length,
  );
});

test("support mocks, fixture barrels and generated workers cannot be owners", () => {
  const file = "platform/backend/src/new-scenario.test.ts";
  for (const target of [
    "platform/backend/src/test/mocks/auth.ts",
    "platform/backend/src/test/fixtures.ts",
    "platform/frontend/public/mockServiceWorker.js",
  ]) {
    const result = inventory(new Set([file, target]), {
      [file]: { targets: [target], reason: "scenario" },
    });
    assert.equal(result.errors.length, 1);
  }
  assert.equal(
    associate(
      "platform/backend/src/test/fixtures.regression.test.ts",
      new Set(["platform/backend/src/test/fixtures.ts"]),
    ),
    null,
  );
});
test("both configured Postgres runners are in scope and can have concrete owners", () => {
  for (const file of [
    "platform/backend/src/test/llm-limits/postgres.integration.ts",
    "platform/backend/src/test/agent-transcripts.postgres.ts",
  ]) {
    assert.equal(isTest(file), true);
    const target = "platform/backend/src/models/limit.ts";
    const result = inventory(new Set([file, target]), {
      [file]: { targets: [target], reason: "real database integration" },
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.rows[0].kind, "explicit");
    assert.equal(inventory(new Set([file])).rows[0].kind, "unassociated");
  }
});
test("matching requires a separator even beside the implementation", () => {
  assert.equal(
    associate(
      "platform/backend/src/limitless.test.ts",
      new Set(["platform/backend/src/limit.ts"]),
    ),
    null,
  );
});

test("legacy, plural and enterprise route associations retain existing conventions", () => {
  for (const [file, owner] of [
    [
      "platform/backend/src/routes/create.agent.route.test.ts",
      "platform/backend/src/routes/agent.ts",
    ],
    [
      "platform/backend/src/routes/plugin/availability.plugin.routes.test.ts",
      "platform/backend/src/routes/plugin/plugin.routes.ts",
    ],
    [
      "platform/backend/src/routes/custom-role.bulk.ee.test.ts",
      "platform/backend/src/routes/custom-role.ee.ts",
    ],
  ])
    assert.deepEqual(associate(file, new Set([owner])).targets, [owner]);
});
test("preview backend handlers are executable owners, not fixture data", () => {
  const owner = "platform/frontend/src/mocks/handlers.ts";
  assert.deepEqual(
    associate(
      "platform/frontend/src/mocks/handlers.agent-catalog.test.ts",
      new Set([owner]),
    ).targets,
    [owner],
  );
});
test("dependency and off-directory runner contracts name exact tracked artifacts", () => {
  const file = "platform/backend/src/clients/sdk.unit.test.ts";
  for (const target of [
    "platform/patches/sdk.patch",
    "platform/pnpm-workspace.yaml",
    "platform/docker_images/agent/bin/archestra-agent-init",
    ".github/workflows/update-client-versions.yml",
  ]) {
    assert.deepEqual(
      inventory(new Set([file, target]), {
        [file]: {
          targets: [target],
          reason: "Runs the committed dependency or entrypoint contract",
        },
      }).errors,
      [],
    );
  }
});
test("removing an implementation invalidates an otherwise unchanged test", () => {
  const file = "platform/shared/calculate.test.ts";
  assert.equal(
    associate(file, new Set(["platform/shared/calculate.ts"])).kind,
    "exact",
  );
  assert.equal(associate(file, new Set()), null);
});

test("CLI checks untracked tests and detects source deletion without running application tests", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-association-cli-"));
  const scripts = path.join(root, "platform/scripts");
  const sources = path.join(root, "platform/backend/src");
  try {
    mkdirSync(scripts, { recursive: true });
    mkdirSync(sources, { recursive: true });
    execFileSync("git", ["init", "--quiet", root]);
    copyFileSync(
      fileURLToPath(new URL("./check-test-associations.mjs", import.meta.url)),
      path.join(scripts, "check-test-associations.mjs"),
    );
    writeFileSync(path.join(scripts, "test-associations.json"), "{}");
    writeFileSync(
      path.join(sources, "calculate.ts"),
      "export const calculate = () => 1;",
    );
    writeFileSync(path.join(sources, "calculate.unit.test.ts"), "");
    const check = () =>
      spawnSync(
        process.execPath,
        [path.join(scripts, "check-test-associations.mjs")],
        { encoding: "utf8" },
      );
    assert.equal(check().status, 0);
    writeFileSync(path.join(sources, "floating.test.ts"), "");
    const floating = check();
    assert.equal(floating.status, 1);
    assert.match(floating.stderr, /floating.test.ts: no implementation owner/);
    rmSync(path.join(sources, "floating.test.ts"));
    rmSync(path.join(sources, "calculate.ts"));
    const deleted = check();
    assert.equal(deleted.status, 1);
    assert.match(
      deleted.stderr,
      /calculate.unit.test.ts: no implementation owner/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
