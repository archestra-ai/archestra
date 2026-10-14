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
      expect.stringContaining(
        'annotator "a.tool-call" is used by earlier sessions with a different binding.',
      ),
    ]);
    await expect(
      declare({ organizationId, userId, content: replacement }),
    ).rejects.toThrow("different binding");
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
