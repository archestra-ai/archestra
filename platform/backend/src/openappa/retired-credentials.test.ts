import {
  parseOpenappaDeclarations,
  validateHostedOpenappaPolicy,
} from "@archestra/openappa-rs";
import config from "@/config";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import OpenAppaPolicyFileModel from "@/models/openappa-policy-file";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import { secretManager } from "@/secrets-manager";
import {
  deleteRuntimeCredentialConnection,
  deleteRuntimeCredentialDefinition,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { openappaBatteriesService } from "./batteries";
import { openappaDeclarations } from "./declarations";

describe("retained annotator credential availability", () => {
  let organizationId: string;
  let userId: string;
  let retainedFingerprint: string;
  let rootRevision: number;
  let connection: Awaited<
    ReturnType<typeof RuntimeCredentialConnectionModel.upsert>
  >;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    config.openappa.enabled = true;
    organizationId = (await makeOrganization()).id;
    userId = (await makeAdmin()).id;
    await makeMember(userId, organizationId, { role: "admin" });
    await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: userId,
      definition: {
        key: KEY,
        name: "Historical judge credential",
        description: "",
        icon: null,
        kind: "secret",
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    connection = await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      userId: null,
      scope: "organization",
      credentialId: KEY,
      value: "test-retained-secret",
    });
    await savePolicy(OLD_POLICY);
    await OpenAppaPolicyFileModel.store(
      (await openappaBatteriesService.getEffectivePolicy(organizationId))
        .content,
    );
    await savePolicy(CURRENT_POLICY);
    const retained =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(retained.lastError).toBeNull();
    expect(retained.content).toContain("jev.tool-call");
    expect(
      (
        await openappaDeclarations.dispatchPolicy({
          organizationId,
          content: retained.content,
        })
      ).credentials,
    ).toEqual({ [VARIABLE]: "test-retained-secret" });
    retainedFingerprint = retained.installFingerprint;
    rootRevision = retained.rootRevision;
  });

  test("deleting a retained-only definition drops it during the lifecycle callback", async () => {
    await deleteRuntimeCredentialDefinition({ organizationId, key: KEY });
    await expectDropped(
      await OpenAppaEffectivePolicyModel.find(organizationId),
    );
  });

  test("clearing and reconnecting a retained-only organization value recomposes both ways", async () => {
    expect(
      await deleteRuntimeCredentialConnection({
        organizationId,
        userId,
        credentialId: KEY,
        scope: "organization",
      }),
    ).toBe(true);
    const dropped = await OpenAppaEffectivePolicyModel.find(organizationId);
    await expectDropped(dropped);

    await setRuntimeCredentialConnection({
      organizationId,
      userId,
      credentialId: KEY,
      scope: "organization",
      value: "test-restored-secret",
    });
    const restored = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(restored?.lastError).toBeNull();
    expect(restored?.content).toContain("jev.tool-call");
    expect(restored?.installFingerprint).not.toBe(dropped?.installFingerprint);
    const dispatch = await openappaDeclarations.dispatchPolicy({
      organizationId,
      content: restored?.content ?? "",
    });
    expect(dispatch.credentials).toEqual({
      [VARIABLE]: "test-restored-secret",
    });
  });

  for (const scenario of ["empty value", "missing value field"] as const) {
    test(`the next effective-policy read drops a retained ${scenario} without a lifecycle callback`, async () => {
      await secretManager().updateSecret(
        connection.secretId,
        scenario === "empty value" ? { [connection.secretKey]: "" } : {},
      );
      expect(
        await RuntimeCredentialConnectionModel.listOrganizationCredentialIds(
          organizationId,
        ),
      ).toContain(KEY);
      expect(
        await RuntimeCredentialDefinitionModel.find({
          organizationId,
          key: KEY,
        }),
      ).not.toBeNull();
      expect(
        (await OpenAppaEffectivePolicyModel.find(organizationId))
          ?.installFingerprint,
      ).toBe(retainedFingerprint);

      await expectDropped(
        await openappaBatteriesService.getEffectivePolicy(organizationId),
      );
    });
  }

  async function savePolicy(content: string) {
    const root = await guardrailsPolicyService.get(organizationId);
    await guardrailsPolicyService.update({
      organizationId,
      userId,
      content,
      expectedRevision: root.revision,
    });
    await openappaBatteriesService.recompile(organizationId);
  }

  async function expectDropped(
    policy: Awaited<ReturnType<typeof OpenAppaEffectivePolicyModel.find>>,
  ) {
    expect(policy).not.toBeNull();
    expect(policy?.lastError).toBeNull();
    expect(policy?.rootRevision).toBe(rootRevision);
    expect(policy?.installFingerprint).not.toBe(retainedFingerprint);
    const content = policy?.content ?? "";
    expect(content).not.toContain("jev.tool-call");
    expect(content).not.toContain(VARIABLE);
    expect(content).toContain("other.judge");
    expect(content).toContain("mcp/files/read");
    expect(
      (await parseOpenappaDeclarations(content)).runtimeCredentials,
    ).toEqual([]);
    const dispatch = await openappaDeclarations.dispatchPolicy({
      organizationId,
      content,
    });
    expect(dispatch.credentials).toEqual({});
    expect(await validateHostedOpenappaPolicy(dispatch.content)).toEqual([]);
  }
});

const KEY = "historical-judge-key";
const VARIABLE = "APPA_PROVIDER_JEV_API_KEY";

const OLD_POLICY = `[policy]
version = 2

[[policy.annotator]]
name = "jev.tool-call"
builtin = "jev"
ranks = ["suspicious", "trusted"]
audiences = ["self", "internal"]
marks = []

[[policy.annotator]]
name = "other.judge"

[[policy.tool]]
name = "mcp/files/read"
annotator = "jev.tool-call"

[externals.jev]
token_env = "${VARIABLE}"

[externals.annotators."other.judge"]
url = "https://other-judge.test/annotate"

[credentials]
${VARIABLE} = "${KEY}"
`;

const CURRENT_POLICY = `[policy]
version = 2

[[policy.tool]]
name = "mcp/files/read"
delta = {}
`;
