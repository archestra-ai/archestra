import { createHash } from "node:crypto";
import { ADMIN_ROLE_NAME, ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { parse as parseToml } from "smol-toml";
import { vi } from "vitest";
import config from "@/config";
import logger from "@/logging";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaPolicyFileModel from "@/models/openappa-policy-file";
import ToolModel from "@/models/tool";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { openappaBatteriesService } from "./batteries";
import { helperUrlBase } from "./declarations";

vi.mock("@/logging");

describe("annotators earlier opening policies declare", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  test("a renamed URL annotator stays declared with its old binding for sessions opened under it", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await declare({ organizationId, userId, content: urlJudged("a", JUDGE_A) });
    await openedUnder(organizationId);

    // The author is told before saving what the rename does to open sessions.
    const preview = await guardrailsPolicyService.validate(
      urlJudged("b", JUDGE_B),
      { organizationId },
    );
    expect(preview.valid).toBe(true);
    expect(preview.warnings).toEqual([
      `annotator "a.tool-call" would no longer be declared; sessions opened under earlier policies still ask for it. The host keeps its previous binding (${JUDGE_A}) for them.`,
    ]);
    vi.mocked(logger.warn).mockClear();

    await declare({ organizationId, userId, content: urlJudged("b", JUDGE_B) });

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.lastError).toBeNull();
    const document = parseToml(effective.content) as {
      policy: { annotator: unknown[] };
      externals: { annotators: Record<string, unknown> };
    };
    expect(document.policy.annotator).toEqual([
      { ...MANDATE, name: "b.tool-call" },
      { ...MANDATE, name: "a.tool-call" },
    ]);
    expect(document.externals.annotators).toEqual({
      "a.tool-call": { url: JUDGE_A },
      "b.tool-call": { url: JUDGE_B },
    });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { organizationId, kept: [{ name: "a.tool-call", binding: JUDGE_A }] },
      "OpenAPPA kept retired externals for sessions opened under earlier policies",
    );

    // Declared again by the author, it is the author's and nothing is kept.
    vi.mocked(logger.warn).mockClear();
    await declare({
      organizationId,
      userId,
      content: urlJudged("a", JUDGE_A),
    });
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  test("with no session opened under the old policy nothing is kept", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await declare({ organizationId, userId, content: urlJudged("a", JUDGE_A) });
    expect(
      (
        await guardrailsPolicyService.validate(urlJudged("b", JUDGE_B), {
          organizationId,
        })
      ).warnings,
    ).toEqual([
      // The next session opens under the current policy, so it is warned about.
      `annotator "a.tool-call" would no longer be declared; sessions opened under earlier policies still ask for it. The host keeps its previous binding (${JUDGE_A}) for them.`,
    ]);

    await declare({ organizationId, userId, content: urlJudged("b", JUDGE_B) });

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.lastError).toBeNull();
    expect(effective.content).not.toContain("a.tool-call");
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  test("a session that opened under the previous composition while the next was stored keeps its annotator within a minute", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await declare({ organizationId, userId, content: urlJudged("a", JUDGE_A) });
    const previous =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    await declare({ organizationId, userId, content: urlJudged("b", JUDGE_B) });
    expect(
      (await openappaBatteriesService.readForDispatch(organizationId)).policy
        .content,
    ).not.toContain("a.tool-call");

    // The session's opening lands after the composition that dropped its annotator.
    await OpenAppaPolicyFileModel.store(previous.content);
    expect(
      (await openappaBatteriesService.readForDispatch(organizationId)).policy
        .content,
    ).not.toContain("a.tool-call");

    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now + 61_000);
    try {
      const kept = (
        await openappaBatteriesService.readForDispatch(organizationId)
      ).policy;
      expect(kept.lastError).toBeNull();
      expect(kept.content).toContain("a.tool-call");
      expect(kept.content).toContain(JUDGE_A);
      expect(kept.content).toContain(JUDGE_B);
    } finally {
      clock.mockRestore();
    }
  });

  test("a corrupt snapshot is logged by hash without blocking valid old bindings", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await declare({ organizationId, userId, content: urlJudged("a", JUDGE_A) });
    await openedUnder(organizationId);
    const policyHash = await OpenAppaPolicyFileModel.store(
      `broken = ["${organizationId}"`,
    );

    await declare({ organizationId, userId, content: urlJudged("b", JUDGE_B) });
    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.lastError).toBeNull();
    expect(effective.content).toContain(JUDGE_A);
    expect(effective.content).toContain(JUDGE_B);
    await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      { policyHash },
      "OpenAPPA skipped a stored opening policy that is not valid TOML",
    );
  });

  test("reusing an open session's annotator name with a different binding is refused", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await declare({ organizationId, userId, content: urlJudged("a", JUDGE_A) });
    await openedUnder(organizationId);
    const replacement = urlJudged("a", JUDGE_B);
    const preview = await guardrailsPolicyService.validate(replacement, {
      organizationId,
    });
    expect(preview.valid).toBe(false);
    expect(preview.errors).toEqual([
      `in this deployment: annotator "a.tool-call" is bound to ${JUDGE_B} in this revision, but sessions opened under earlier policies were answered by ${JUDGE_A} and would be redirected. Declare the new binding under a new annotator name so those sessions keep theirs.`,
    ]);
    await expect(
      declare({ organizationId, userId, content: replacement }),
    ).rejects.toThrow("Declare the new binding under a new annotator name");
    expect(
      (await openappaBatteriesService.getEffectivePolicy(organizationId))
        .content,
    ).toContain(JUDGE_A);
    expect(
      (await guardrailsPolicyService.get(organizationId)).content,
    ).toContain(JUDGE_A);
  });

  test("a builtin annotator is kept on its builtin", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await declare({
      organizationId,
      userId,
      content: archestraJudged("jev.tool-call"),
    });
    await openedUnder(organizationId);

    await declare({
      organizationId,
      userId,
      content: archestraJudged("archestra.tool-call"),
    });

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.lastError).toBeNull();
    expect(
      (parseToml(effective.content) as { policy: { annotator: unknown[] } })
        .policy.annotator,
    ).toEqual([
      { ...MANDATE, name: "archestra.tool-call", builtin: "archestra" },
      { ...MANDATE, name: "jev.tool-call", builtin: "archestra" },
    ]);
  });

  test("a rebinding the current revision already carries is served, logged and warned about, never refused", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await declare({ organizationId, userId, content: urlJudged("a", JUDGE_A) });
    await openedUnder(organizationId);
    vi.mocked(logger.warn).mockClear();

    // The root was rebound without this check, as earlier builds allowed.
    await declare({
      organizationId,
      userId,
      content: urlJudged("a", JUDGE_B),
      checked: false,
    });

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.lastError).toBeNull();
    expect(effective.content).toContain(JUDGE_B);
    expect(effective.content).not.toContain(JUDGE_A);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      {
        organizationId,
        annotator: "a.tool-call",
        current: JUDGE_B,
        earlier: [JUDGE_A],
      },
      "OpenAPPA answers an annotator with a binding that differs from earlier opening policies; sessions opened under them are answered by the current binding",
    );

    // A later revision that keeps that binding is warned about, not refused,
    // and takes effect: the stored snapshot does not pin the served policy.
    const next = `${urlJudged("a", JUDGE_B)}\n[externals]\ntimeout_ms = 4000\n`;
    const preview = await guardrailsPolicyService.validate(next, {
      organizationId,
    });
    expect(preview.valid).toBe(true);
    expect(preview.warnings).toEqual([
      `in this deployment: annotator "a.tool-call" stays bound to ${JUDGE_B}; sessions opened under earlier policies were answered by ${JUDGE_A} and have been answered by ${JUDGE_B} since the revision that rebound it. This revision changes nothing for them.`,
    ]);
    await declare({ organizationId, userId, content: next });
    const served =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(served.lastError).toBeNull();
    expect(served.rootRevision).toBe(effective.rootRevision + 1);
    expect(served.content).toContain("timeout_ms = 4000");

    // Binding the name a third way redirects those sessions again: an error.
    const third = urlJudged("a", "https://judge-c.test/annotate");
    const rebound = await guardrailsPolicyService.validate(third, {
      organizationId,
    });
    expect(rebound.valid).toBe(false);
    expect(rebound.errors).toEqual([
      expect.stringMatching(
        /^in this deployment: annotator "a\.tool-call" is bound to https:\/\/judge-c\.test\/annotate in this revision, but sessions opened under earlier policies were answered by .* and would be redirected\. Declare the new binding under a new annotator name so those sessions keep theirs\.$/,
      ),
    ]);
    expect(rebound.errors[0]).toContain(JUDGE_A);
    expect(rebound.errors[0]).toContain(JUDGE_B);
  });

  test("rebinding a name no session opened under is still an error, since the next session opens under the effective policy", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await declare({ organizationId, userId, content: urlJudged("a", JUDGE_A) });
    const preview = await guardrailsPolicyService.validate(
      urlJudged("a", JUDGE_B),
      { organizationId },
    );
    expect(preview.valid).toBe(false);
    expect(preview.errors).toEqual([
      expect.stringContaining(
        `annotator "a.tool-call" is bound to ${JUDGE_B} in this revision, but sessions opened under earlier policies were answered by ${JUDGE_A}`,
      ),
    ]);
  });

  test("a battery helper answered under a previous install id is the same binding, so the policy is neither refused nor pinned", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const uploaded = await openappaBatteriesService.uploadPackage({
      userId,
      organizationId,
      name: "helper",
      files: [
        {
          path: "appa-package.toml",
          text: 'schema = 1\nname = "helper"\ndescription = "A judge run by the host"\n[battery]\npolicy = "appa.toml"\nhosts = []\nnamespaces = ["helper"]\nhelpers = ["judge.py"]\n',
        },
        {
          path: "appa.toml",
          text: '[policy]\nversion = 2\n[[policy.annotator]]\nname = "helper.judge"\nranks = ["suspicious", "trusted"]\naudiences = ["self"]\nmarks = []\n[externals.annotators."helper.judge"]\ncommand = ["python3", "judge.py"]\n[[policy.tool]]\nname = "mcp/helper/list_agents"\nannotator = "helper.judge"\n',
        },
        { path: "judge.py", text: "print('{}')\n" },
      ],
    });
    await openappaBatteriesService.createInstall({
      userId,
      organizationId,
      install: {
        batteryName: "helper",
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        packageHash: uploaded.contentHash,
      },
    });
    const install = (
      await OpenAppaBatteryInstallModel.list(organizationId)
    ).find((row) => row.batteryName === "helper");
    expect(install).toBeDefined();
    if (!install) throw new Error("no install");
    const before =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    const url = `${helperUrlBase(install.id)}/helper.judge`;
    expect(before.content).toContain(`url = "${url}"`);

    // A session opened while the same helper was served under an earlier
    // install row, as a reinstall or a re-created catalog leaves behind.
    const retired = "11111111-2222-4333-8444-555555555555";
    await OpenAppaPolicyFileModel.store(
      before.content.replaceAll(install.id, retired),
    );
    vi.mocked(logger.warn).mockClear();

    const root = await guardrailsPolicyService.get(organizationId);
    const document = parseToml(root.content);
    const policy = document.policy as { annotator: unknown[]; tool: unknown[] };
    policy.annotator = [
      ...policy.annotator,
      { ...MANDATE, name: "b.tool-call" },
    ];
    policy.tool = [{ name: "*", annotator: "b.tool-call" }];
    const { stringify } = await import("smol-toml");
    const current = `${stringify(document)}\n[externals.annotators."b.tool-call"]\nurl = "${JUDGE_B}"\n`;
    const preview = await guardrailsPolicyService.validate(current, {
      organizationId,
    });
    expect(preview).toEqual({ valid: true, errors: [], warnings: [] });
    await declare({ organizationId, userId, content: current });

    const served =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(served.lastError).toBeNull();
    expect(served.rootRevision).toBe(before.rootRevision + 1);
    expect(served.content).toContain(JUDGE_B);
    expect(served.content).toContain(`url = "${url}"`);
    expect(served.content).not.toContain(retired);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("differs from earlier opening policies"),
    );
  });

  test("a host-bound helper keeps its bridge token without adding old tool rules", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const root = await guardrailsPolicyService.get(organizationId);
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    await openappaBatteriesService.getEffectivePolicy(organizationId);
    const [install] = await OpenAppaBatteryInstallModel.list(organizationId);
    expect(install).toBeDefined();
    const url = `${helperUrlBase(install.id)}/annotators/a.tool-call`;
    const native = await import("@archestra/openappa-rs");
    const opening = await native.composeOpenappaPolicy({
      root: `include = ["batteries/helper/appa.toml"]\n[policy]\nversion = 2\n`,
      batteries: [
        {
          entry: "batteries/helper/appa.toml",
          name: "helper",
          policy: urlJudged("a", url).replace(
            `url = "${url}"`,
            'command = ["python3", "judge.py"]',
          ),
          helpers: {
            urlBase: `${helperUrlBase(install.id)}/annotators`,
            tokenEnv: "APPA_ARCHESTRA_BRIDGE_TOKEN",
          },
        },
      ],
    });
    expect(opening.errors).toEqual([]);
    await OpenAppaPolicyFileModel.store(opening.content ?? "");
    const document = parseToml(root.content);
    const policy = document.policy as { annotator: unknown[]; tool: unknown[] };
    policy.annotator = [
      ...policy.annotator,
      { ...MANDATE, name: "b.tool-call" },
    ];
    policy.tool = [{ name: "*", annotator: "b.tool-call" }];
    // Keep the existing install, but use only the new root's tool rules.
    const { stringify } = await import("smol-toml");
    const current = `${stringify(document)}\n[externals.annotators."b.tool-call"]\nurl = "${JUDGE_B}"\n`;
    await declare({ organizationId, userId, content: current });

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.lastError).toBeNull();
    const hosted = parseToml(effective.content) as {
      policy: { tool: unknown[] };
      externals: { annotators: Record<string, unknown> };
    };
    expect(hosted.externals.annotators["a.tool-call"]).toEqual({
      url,
      token_env: "APPA_ARCHESTRA_BRIDGE_TOKEN",
    });
    expect(hosted.policy.tool).not.toContainEqual({
      name: "*",
      annotator: "a.tool-call",
    });
    expect(
      await native.validateHostedOpenappaPolicy(effective.content),
    ).toEqual([]);
    expect(await native.validateOpenappaPolicy(effective.content)).not.toEqual(
      [],
    );
  });

  test("an annotator whose helper's install is gone is not kept, and the author is told", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const gone = `${helperUrlBase("removed-install")}/annotators/a.tool-call`;
    await declare({ organizationId, userId, content: urlJudged("a", gone) });
    await openedUnder(organizationId);

    expect(
      (
        await guardrailsPolicyService.validate(urlJudged("b", JUDGE_B), {
          organizationId,
        })
      ).warnings,
    ).toEqual([
      'annotator "a.tool-call" would no longer be declared and cannot be kept for sessions opened under earlier policies (the battery install whose helper answered it no longer exists); those sessions will be told to start a new conversation.',
    ]);
    vi.mocked(logger.warn).mockClear();

    await declare({ organizationId, userId, content: urlJudged("b", JUDGE_B) });

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.lastError).toBeNull();
    expect(effective.content).not.toContain("a.tool-call");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      {
        organizationId,
        annotator: "a.tool-call",
        reason: "the battery install whose helper answered it no longer exists",
      },
      "OpenAPPA cannot keep a retired annotator for sessions opened under earlier policies",
    );
  });

  test("a kept annotator the runtime refuses is left out and the others are kept", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await admin({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await declare({ organizationId, userId, content: urlJudged("a", JUDGE_A) });
    await openedUnder(organizationId);
    // An opening policy whose annotator names a builtin this runtime lacks.
    await OpenAppaPolicyFileModel.store(`[policy]
version = 2

[[policy.annotator]]
name = "x.judge"
builtin = "no-such-builtin"
`);

    await declare({ organizationId, userId, content: urlJudged("b", JUDGE_B) });

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.lastError).toBeNull();
    expect(effective.content).toContain("a.tool-call");
    expect(effective.content).not.toContain("x.judge");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { organizationId, annotator: "x.judge", reason: expect.any(String) },
      "OpenAPPA cannot keep a retired annotator for sessions opened under earlier policies",
    );
  });
});

// =============================================================================
// Helpers
// =============================================================================

const MANDATE = {
  ranks: ["suspicious", "trusted"],
  audiences: ["self"],
  marks: [],
};
const JUDGE_A = "https://judge-a.test/annotate";
const JUDGE_B = "https://judge-b.test/annotate";

/** A root whose one URL-bound annotator `<prefix>.tool-call` judges every tool. */
function urlJudged(prefix: string, url: string): string {
  const name = `${prefix}.tool-call`;
  return `[policy]
version = 2

[[policy.annotator]]
name = "${name}"
ranks = ["suspicious", "trusted"]
audiences = ["self"]
marks = []

[[policy.tool]]
name = "*"
annotator = "${name}"

[externals.annotators."${name}"]
url = "${url}"
`;
}

/** A root whose one annotator, on the archestra builtin, judges every tool. */
function archestraJudged(name: string): string {
  return `[policy]
version = 2

[[policy.annotator]]
name = "${name}"
builtin = "archestra"
ranks = ["suspicious", "trusted"]
audiences = ["self"]
marks = []

[[policy.tool]]
name = "*"
annotator = "${name}"
`;
}

/** Store the effective policy as the runtime does when a session opens under it. */
async function openedUnder(organizationId: string) {
  await OpenAppaPolicyFileModel.store(
    (await openappaBatteriesService.getEffectivePolicy(organizationId)).content,
  );
}

async function admin(fixtures: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    params: { role: string },
  ) => Promise<unknown>;
}) {
  const organizationId = (await fixtures.makeOrganization()).id;
  const userId = (await fixtures.makeUser()).id;
  await fixtures.makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
  return { organizationId, userId };
}

/** Save a root revision and recompose from it. */
async function declare(params: {
  organizationId: string;
  userId: string;
  content: string;
  checked?: boolean;
}) {
  const { organizationId, userId, content } = params;
  const latest = await guardrailsPolicyService.get(organizationId);
  if (params.checked === false) {
    await GuardrailsPolicyModel.save({
      organizationId,
      updatedBy: userId,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      expectedRevision: latest.revision,
    });
  } else {
    await guardrailsPolicyService.update({
      organizationId,
      userId,
      content,
      expectedRevision: latest.revision,
    });
  }
  await openappaBatteriesService.recompile(organizationId);
}
