import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parse as parseToml } from "smol-toml";
import config from "@/config";
import AuditLogModel from "@/models/audit-log";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaCredentialBindingModel from "@/models/openappa-credential-binding";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import { ARCHESTRA_BATTERY } from "@/openappa/archestra-audience";
import { bundledEntry } from "@/openappa/declarations";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

const GITHUB_TOKEN = "APPA_PROVIDER_GITHUB_TOKEN";

let organizationId: string;
let adminId: string;
let agent: ArchestraContext["agent"];

beforeEach(
  async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    config.openappa.enabled = true;
    organizationId = (await makeOrganization()).id;
    adminId = (await makeUser()).id;
    await makeMember(adminId, organizationId, { role: "admin" });
    const created = await makeAgent({ organizationId });
    await seedAndAssignArchestraTools(created.id);
    agent = { id: created.id, name: created.name };
    await RuntimeCredentialDefinitionModel.create({
      // Not shared with the organization, which a new credential is by
      // default: these tests decide who else may use it.
      initialPermissionGrants: [],
      organizationId,
      createdBy: adminId,
      definition: {
        key: "github-token",
        name: "GitHub token",
        kind: "secret",
        description: "",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "organization",
      userId: null,
      credentialId: "github-token",
      value: "ghp_bound_under_test",
    });
  },
);

function bind(key: string | null, userId = adminId) {
  return executeArchestraTool(
    "archestra__bind_guardrails_credential",
    { variable: GITHUB_TOKEN, key },
    { agent, organizationId, userId },
  );
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const [block] = result.content;
  return block?.type === "text" ? block.text : "";
}

function call(tool: string, args: Record<string, unknown>) {
  return executeArchestraTool(`archestra__${tool}`, args, {
    agent,
    organizationId,
    userId: adminId,
  });
}

/** The starter policy with the bundled github battery included. */
function withGithub(): string {
  const archestra = bundledEntry(ARCHESTRA_BATTERY);
  return initialPolicy().replace(
    `"${archestra}",\n`,
    `"${archestra}",\n  "${bundledEntry("github")}",\n`,
  );
}

/** The JSON text the model reads from a tool result. */
function modelView(result: CallToolResult) {
  expect(result.isError).toBeFalsy();
  const [block] = result.content;
  return JSON.parse(block?.type === "text" ? block.text : "null") as {
    effective: {
      error: string | null;
      credentialBindings: { variable: string; key: string }[];
      content?: string;
    };
  };
}

function credentialLine(key: string): string {
  return `\n[credentials]\n${GITHUB_TOKEN} = "${key}"\n`;
}

async function saveFromPolicyTab(content: string) {
  const { revision } = await guardrailsPolicyService.get(organizationId);
  return guardrailsPolicyService.update({
    organizationId,
    userId: adminId,
    content,
    expectedRevision: revision,
  });
}

/** A revision written before validation refused `[credentials]` lines. */
async function storeLegacyPolicy(content: string) {
  const { revision } = await guardrailsPolicyService.get(organizationId);
  await GuardrailsPolicyModel.save({
    organizationId,
    updatedBy: adminId,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    expectedRevision: revision,
  });
}

function storedKey() {
  return OpenAppaCredentialBindingModel.find({
    organizationId,
    variable: GITHUB_TOKEN,
  }).then((row) => row?.credentialKey ?? null);
}

describe("bind_guardrails_credential", () => {
  test("binds and unbinds a variable without a policy revision, and audits each change", async () => {
    const bound = await bind("github-token");
    expect(bound.isError).toBeFalsy();
    expect(await storedKey()).toBe("github-token");

    const unbound = await bind(null);
    expect(unbound.isError).toBeFalsy();
    expect(await storedKey()).toBeNull();
    expect((await guardrailsPolicyService.get(organizationId)).revision).toBe(
      0,
    );

    // The audit write is fire-and-forget; give it a beat to land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "openappaCredentialBinding",
      limit: 10,
      offset: 0,
    });
    expect(
      data
        .map((row) => ({
          action: row.action,
          actorId: row.actorId,
          resourceId: row.resourceId,
          before: row.before,
          after: row.after,
        }))
        .reverse(),
    ).toEqual([
      {
        action: "openappaCredentialBinding.updated",
        actorId: adminId,
        resourceId: GITHUB_TOKEN,
        before: null,
        after: { variable: GITHUB_TOKEN, key: "github-token" },
      },
      {
        action: "openappaCredentialBinding.updated",
        actorId: adminId,
        resourceId: GITHUB_TOKEN,
        before: { variable: GITHUB_TOKEN, key: "github-token" },
        after: null,
      },
    ]);
  });

  test("policy reads and publishes list bindings and carry the composed text only on request", async () => {
    await bind("github-token");
    const binding = { variable: GITHUB_TOKEN, key: "github-token" };

    const published = modelView(
      await call("update_guardrails_policy", {
        content: withGithub(),
        expectedRevision: 0,
      }),
    );
    expect(published.effective.credentialBindings).toEqual([binding]);
    expect(published.effective).not.toHaveProperty("content");

    const read = modelView(await call("get_guardrails_policy", {}));
    expect(read.effective.error).toBeNull();
    expect(read.effective.credentialBindings).toEqual([binding]);
    expect(read.effective).not.toHaveProperty("content");

    const composed = modelView(
      await call("get_guardrails_policy", { composed: true }),
    );
    expect(composed.effective.credentialBindings).toEqual([binding]);
    expect(
      (parseToml(composed.effective.content ?? "") as { credentials: unknown })
        .credentials,
    ).toEqual({ [GITHUB_TOKEN]: "github-token" });
  });

  test("takes use on the credential on top of policy update", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const policyOnly = await makeCustomRole(organizationId, {
      permission: { guardrailsPolicy: ["read", "update"] },
    });
    const editor = (await makeUser()).id;
    await makeMember(editor, organizationId, { role: policyOnly.role });
    // Without a grant the credential is not even visible to them.
    await expect(bind("github-token", editor)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await storedKey()).toBeNull();

    const binder = (await makeUser()).id;
    await makeMember(binder, organizationId, { role: policyOnly.role });
    await grantCredentialUse({
      organizationId,
      key: "github-token",
      userId: binder,
    });
    expect((await bind("github-token", binder)).isError).toBeFalsy();
    expect(await storedKey()).toBe("github-token");
  });

  test("a variable a stored policy text binds is refused as a tool error", async () => {
    await storeLegacyPolicy(`${withGithub()}${credentialLine("github-token")}`);

    expect(errorText(await bind("github-token"))).toContain(
      `${GITHUB_TOKEN} is set by a [credentials] line in the policy text`,
    );
    expect(await storedKey()).toBeNull();
  });

  test("a key with no organization value is refused as a tool error", async () => {
    expect(errorText(await bind("no-such-key"))).toBe(
      "Error: no-such-key is not a credential with an organization value",
    );
    expect(await storedKey()).toBeNull();
  });
});

describe("[credentials] lines on the agent path", () => {
  const REFUSAL = `Bind ${GITHUB_TOKEN} with bind_guardrails_credential instead of a [credentials] line`;

  function proposeBoth(content: string, expectedRevision: number) {
    return Promise.all([
      call("preview_guardrails_policy_change", { content, expectedRevision }),
      call("update_guardrails_policy", { content, expectedRevision }),
    ]);
  }

  test("preview and publish refuse a line the agent adds or rekeys", async () => {
    await saveFromPolicyTab(withGithub());
    for (const result of await proposeBoth(
      `${withGithub()}${credentialLine("github-token")}`,
      1,
    ))
      expect(errorText(result)).toContain(REFUSAL);
    expect((await guardrailsPolicyService.get(organizationId)).revision).toBe(
      1,
    );
  });

  test("a stored line must go before anything else publishes", async () => {
    await storeLegacyPolicy(`${withGithub()}${credentialLine("github-token")}`);
    const kept = `${withGithub()}# reviewed\n${credentialLine("github-token")}`;
    const previewed = await call("preview_guardrails_policy_change", {
      content: kept,
      expectedRevision: 1,
    });
    expect(previewed.structuredContent).toMatchObject({ valid: false });
    expect(
      (
        await call("update_guardrails_policy", {
          content: kept,
          expectedRevision: 1,
        })
      ).isError,
    ).toBe(true);

    expect(
      (
        await call("update_guardrails_policy", {
          content: withGithub(),
          expectedRevision: 1,
        })
      ).isError,
    ).toBeFalsy();
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      withGithub(),
    );
  });

  test("a root token_env is refused on every agent path, administrator included", async () => {
    const external = `${initialPolicy()}\n[externals.jev]\ntoken_env = "APPA_PROVIDER_JEV_API_KEY"\n`;
    const refusal = 'remove token_env = "APPA_PROVIDER_JEV_API_KEY"';
    const previewed = await call("preview_guardrails_policy_change", {
      content: external,
      expectedRevision: 0,
    });
    expect(previewed.structuredContent).toMatchObject({ valid: false });
    expect(
      (previewed.structuredContent as { errors: string[] }).errors.join("\n"),
    ).toContain(refusal);
    const published = await call("update_guardrails_policy", {
      content: external,
      expectedRevision: 0,
    });
    expect(published.isError).toBe(true);
    expect(errorText(published)).toContain(refusal);
    expect((await guardrailsPolicyService.get(organizationId)).revision).toBe(
      0,
    );
  });

  test("validation refuses a line, with where to bind instead", async () => {
    const validate = (content: string) =>
      call("validate_guardrails_policy", { content });
    expect((await validate(withGithub())).structuredContent).toMatchObject({
      valid: true,
      warnings: [],
    });
    const lined = await validate(
      `${withGithub()}${credentialLine("github-token")}`,
    );
    expect(lined.structuredContent).toMatchObject({ valid: false });
    expect(
      (lined.structuredContent as { errors: string[] }).errors.some((error) =>
        error.includes(
          `remove ${GITHUB_TOKEN} from the policy text and bind it with bind_guardrails_credential`,
        ),
      ),
    ).toBe(true);
  });
});

/** Grant one person `use` on a credential, the way its Permissions tab would. */
async function grantCredentialUse(params: {
  organizationId: string;
  key: string;
  userId: string;
}) {
  const definition = await RuntimeCredentialDefinitionModel.find(params);
  if (!definition) throw new Error(`No credential ${params.key}`);
  const scope = {
    organizationId: params.organizationId,
    resource: "credential" as const,
    scope: definition.id,
  };
  const policy = await ResourcePermissionPolicyModel.find(scope);
  await ResourcePermissionPolicyModel.replace({
    ...scope,
    revision: policy?.revision ?? 0,
    grants: [
      ...(policy?.grants ?? []),
      {
        subject: { type: "user", id: params.userId },
        actions: ["read", "use"],
      },
    ],
  });
}
