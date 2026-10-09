import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import config from "@/config";
import AuditLogModel from "@/models/audit-log";
import OpenAppaCredentialBindingModel from "@/models/openappa-credential-binding";
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
    `include = ["${archestra}"]`,
    `include = ["${archestra}", "${bundledEntry("github")}"]`,
  );
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

  test("takes credential update on top of policy update", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const policyOnly = await makeCustomRole(organizationId, {
      permission: { openappaPolicy: ["read", "update"] },
    });
    const editor = (await makeUser()).id;
    await makeMember(editor, organizationId, { role: policyOnly.role });
    await expect(bind("github-token", editor)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await storedKey()).toBeNull();

    const both = await makeCustomRole(organizationId, {
      permission: {
        openappaPolicy: ["read", "update"],
        credential: ["update"],
      },
    });
    const binder = (await makeUser()).id;
    await makeMember(binder, organizationId, { role: both.role });
    expect((await bind("github-token", binder)).isError).toBeFalsy();
    expect(await storedKey()).toBe("github-token");
  });

  test("a variable the policy text binds is refused as a tool error", async () => {
    await saveFromPolicyTab(`${withGithub()}${credentialLine("github-token")}`);

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

    await saveFromPolicyTab(`${withGithub()}${credentialLine("github-token")}`);
    for (const result of await proposeBoth(
      `${withGithub()}${credentialLine("other-token")}`,
      2,
    ))
      expect(errorText(result)).toContain(REFUSAL);
    expect((await guardrailsPolicyService.get(organizationId)).revision).toBe(
      2,
    );
  });

  test("an edit that keeps a line, or removes it, publishes", async () => {
    await saveFromPolicyTab(`${withGithub()}${credentialLine("github-token")}`);
    const kept = `${withGithub()}# reviewed\n${credentialLine("github-token")}`;
    const previewed = await call("preview_guardrails_policy_change", {
      content: kept,
      expectedRevision: 1,
    });
    expect(previewed.isError).toBeFalsy();
    expect(
      (
        await call("update_guardrails_policy", {
          content: kept,
          expectedRevision: 1,
        })
      ).isError,
    ).toBeFalsy();

    expect(
      (
        await call("update_guardrails_policy", {
          content: withGithub(),
          expectedRevision: 2,
        })
      ).isError,
    ).toBeFalsy();
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      withGithub(),
    );
  });

  test("a line a root external reads takes credential update on every agent path", async ({
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const author = (await makeUser()).id;
    const role = await makeCustomRole(organizationId, {
      permission: { openappaPolicy: ["read", "update"] },
    });
    await makeMember(author, organizationId, { role: role.role });
    const as = (userId: string, tool: string, args: Record<string, unknown>) =>
      executeArchestraTool(`archestra__${tool}`, args, {
        agent,
        organizationId,
        userId,
      });
    const reader = (key: string) =>
      `${initialPolicy()}\n[credentials]\nAPPA_PROVIDER_JEV_API_KEY = "${key}"\n[externals.jev]\ntoken_env = "APPA_PROVIDER_JEV_API_KEY"\n`;
    const external = reader("github-token");
    const forbidden = { statusCode: 403 };
    await expect(
      as(author, "preview_guardrails_policy_change", {
        content: external,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      as(author, "update_guardrails_policy", {
        content: external,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      as(author, "preview_openappa_validation_change", {
        expectedRevision: 0,
        expectedVersion: "empty",
        policyContent: external,
      }),
    ).rejects.toMatchObject(forbidden);
    expect((await guardrailsPolicyService.get(organizationId)).revision).toBe(
      0,
    );

    const previewed = await call("preview_guardrails_policy_change", {
      content: external,
      expectedRevision: 0,
    });
    expect(previewed.structuredContent).toMatchObject({ valid: true });
    expect(
      (
        await call("update_guardrails_policy", {
          content: external,
          expectedRevision: 0,
        })
      ).isError,
    ).toBeFalsy();

    // Leaving the line alone, or removing it, stays the author's to write.
    const kept = external.replace(
      "[credentials]",
      '[[policy.tool]]\nname = "kept"\ndelta = {}\n[credentials]',
    );
    expect(
      (
        await as(author, "update_guardrails_policy", {
          content: kept,
          expectedRevision: 1,
        })
      ).isError,
    ).toBeFalsy();
    await expect(
      as(author, "preview_guardrails_policy_change", {
        content: reader("another-key"),
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject(forbidden);
    expect(
      (
        await as(author, "update_guardrails_policy", {
          content: initialPolicy(),
          expectedRevision: 2,
        })
      ).isError,
    ).toBeFalsy();
  });

  test("a validation change cannot carry the line either", async () => {
    await saveFromPolicyTab(withGithub());
    await expect(
      call("preview_openappa_validation_change", {
        expectedRevision: 1,
        expectedVersion: "empty",
        policyContent: `${withGithub()}${credentialLine("github-token")}`,
      }),
    ).rejects.toThrow(REFUSAL);
  });

  test("validation warns about a line that overrides a binding, and only then", async () => {
    const warnings = async (content: string) => {
      const result = await call("validate_guardrails_policy", { content });
      expect(result.structuredContent).toMatchObject({ valid: true });
      return (result.structuredContent as { warnings: string[] }).warnings;
    };
    expect(await warnings(withGithub())).toEqual([]);
    expect(
      await warnings(`${withGithub()}${credentialLine("github-token")}`),
    ).toEqual([
      `[credentials] in the policy text overrides the stored binding for ${GITHUB_TOKEN}. Prefer bind_guardrails_credential; a text line locks the key in the Batteries dialog.`,
    ]);
  });
});
