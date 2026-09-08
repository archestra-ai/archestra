import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startMockGithub } from "./mock-github-server.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const client = join(testDir, "tool-client.mjs");
const fixture = join(testDir, "fixture-agent.mjs");
const execFileAsync = promisify(execFile);

test("stable cut through next beta records only operator HITL approvals", async () => {
  await withHarness("fresh", async ({ run, harness }) => {
    await harness.operator("approve-stable-cut");
    await run("start-stable");
    await run("lock-old-line");
    let state = await harness.snapshot();
    assert.equal(state.phase, "qualifying");
    assert.equal(state.approvals.environment, false);
    assert.equal(state.prs.find((pr) => pr.number === 1).state, "CLOSED");
    assert.deepEqual(state.policies, ["release/1.4"]);
    assert.equal(state.rulesets.some((rule) => rule.kind === "eol" && rule.ref === "release/1.3"), true);
    assert.equal(state.releases.at(-1).draft, true);

    await harness.operator("approve-environment");
    await run("finish-stable");
    state = await harness.snapshot();
    assert.equal(state.phase, "next-beta-approval");
    assert.equal(state.releases.at(-1).draft, false);

    await assertFailure(() => run("start-beta"), "cannot create beta-config");
    await harness.operator("approve-next-beta");
    await run("start-beta");
    state = await harness.snapshot();
    assert.equal(state.phase, "done");
    assert.equal(state.releases.at(-1).tag, "platform-v1.5.0-beta.1");
    assert.equal(state.events.some((event) => event.type === "rolling-beta-resumed"), true);
  });
});

test("gh api parser keeps a POST endpoint separate from field values", async () => {
  await withHarness("fresh", async ({ run, harness }) => {
    await harness.operator("approve-stable-cut");
    await run("start-stable");
    const state = await harness.snapshot();
    const queueRequest = state.events.find((event) => event.type === "api" && event.method === "POST" && event.fields.name === "release/1.4 queue");
    assert.equal(queueRequest.endpoint, "repos/mock/archestra/rulesets");
  });
});

test("untrusted process cannot read state or approve an environment", async () => {
  await withHarness("fresh", async ({ run, harness }) => {
    await assertFailure(() => run("direct-state-read"));
    await assertFailure(() => run("direct-operator-action"));
    await assertFailure(() => run("forbidden-environment-approval"), "environment approval is an operator action");
    const state = await harness.snapshot();
    assert.equal(state.approvals.environment, false);
    assert.equal(state.events.some((event) => event.type === "operator-action"), false);
  });
});

test("permission denial, approval denial, rules drift, and busy old line fail closed", async (t) => {
  for (const scenario of ["permission-denied", "rules-drift", "busy-old-line"]) {
    await t.test(scenario, async () => withHarness(scenario, async ({ run, harness }) => {
      await assertFailure(() => run("preflight"));
      const state = await harness.snapshot();
      assert.equal(state.events.filter((event) => event.type === "stable-branch-created").length, 0);
    }));
  }
  await t.test("approval denied", async () => withHarness("fresh", async ({ run, harness }) => {
    await harness.operator("deny-stable-cut");
    await assertFailure(() => run("start-stable"));
    const state = await harness.snapshot();
    assert.equal(state.branches["release/1.4"], undefined);
  }));
});

test("branch creation failure restores the core ruleset before stopping", async () => {
  await withHarness("branch-create-failure", async ({ run, harness }) => {
    await harness.operator("approve-stable-cut");
    await assertFailure(() => run("start-stable"), "simulated branch creation failure");
    const state = await harness.snapshot();
    assert.equal(state.coreRuleset.doNotEnforceOnCreate, false);
    assert.equal(state.events.filter((event) => event.type === "core-exemption-restored").length, 1);
    assert.equal(state.rulesets.some((rule) => rule.ref === "release/1.4"), false);
  });
});

test("resume does not recreate existing branch, tag, or PR", async () => {
  await withHarness("resume", async ({ run, harness }) => {
    const before = await harness.snapshot();
    await run("resume");
    const after = await harness.snapshot();
    assert.deepEqual(after.branches, before.branches);
    assert.deepEqual(after.tags, before.tags);
    assert.deepEqual(after.prs, before.prs);
    assert.equal(after.artifacts.verified, true);
  });
});

test("failed initial qualification creates a next-patch candidate after recovery authorization", async () => {
  await withHarness("failed-qualification", async ({ run, harness }) => {
    await assertFailure(() => run("recover-next-patch"));
    await harness.operator("authorize-recovery");
    await run("recover-next-patch");
    const state = await harness.snapshot();
    assert.equal(state.releases.some((release) => release.tag === "platform-v1.4.0" && release.draft), true);
    assert.equal(state.releases.some((release) => release.tag === "platform-v1.4.1" && release.draft), true);
    assert.equal(state.phase, "qualifying");
  });
});

test("partial publication reruns original artifacts only after fresh verification and authorization", async () => {
  await withHarness("partial-publication", async ({ run, harness }) => {
    await assertFailure(() => run("retry-partial"), "fresh operator authorization is required");
    await harness.operator("approve-retry");
    await run("retry-partial");
    const state = await harness.snapshot();
    assert.equal(state.phase, "qualifying");
    assert.equal(state.runs.length, 1);
    assert.equal(state.runs[0].id, 900);
    assert.equal(state.releases.length, 2);
  });
});

test("stable backports require cherry-pick -x and reject direct main merges", async () => {
  await withHarness("stable-backport", async ({ run, harness }) => {
    await run("backport");
    const state = await harness.snapshot();
    assert.equal(state.events.some((event) => event.type === "backport-created"), true);
    await assertFailure(() => run("direct-main-merge"), "main must not merge directly into a release branch");
  });
});

async function withHarness(scenario, callback) {
  const harness = await startMockGithub({ scenario });
  const bin = mkdtempSync(join(tmpdir(), "release-harness-bin-"));
  try {
    for (const tool of ["gh", "git"]) {
      const shim = join(bin, tool);
      writeFileSync(shim, `#!/bin/sh\nexec \"${process.execPath}\" \"${client}\" \"${tool}\" \"$@\"\n`);
      chmodSync(shim, 0o755);
    }
    await callback({
      harness,
      async run(name) {
        await execFileAsync(process.execPath, [fixture, name], {
          env: { PATH: `${bin}:${process.env.PATH}`, RELEASE_HARNESS_URL: harness.url },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      },
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
    await harness.stop();
  }
}

async function assertFailure(action, message) {
  await assert.rejects(action(), (error) => !message || error.stderr?.includes(message));
}
