import { serviceAccountUserId } from "@/auth/service-account-user-id";
import { RuntimeCredentialDefinitionModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import {
  createRuntimeCredentialDefinition,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import { expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import {
  preflightAgentRuntimeCredentials,
  resolveAgentRuntimeCredentials,
} from "./agent-runtime/credentials";
import { resolveMcpCredentialValues } from "./credentials";

test("runtime and MCP credential batches read definitions once and observe deletion on the next operation", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const owner = { organizationId: org.id, userId: user.id };
  const keys = ["first-access", "second-access", "third-access"];
  for (const key of keys) {
    await createRuntimeCredentialDefinition({
      ...owner,
      definition: {
        key,
        name: key,
        description: "",
        icon: null,
        allowPersonal: true,
        allowOrganization: false,
      },
    });
    await setRuntimeCredentialConnection({
      ...owner,
      credentialId: key,
      scope: "personal",
      value: `example-${key}`,
    });
  }
  const runtime = {
    agentId: agent.id,
    secretId: null,
    credentials: keys.map((key) => ({
      key,
      credentialId: key,
      scope: "per_user" as const,
      label: key,
      required: true,
    })),
  };
  const environment = keys.map((key) => ({
    key,
    credentialId: key,
    credentialScope: "personal" as const,
    type: "secret",
    promptOnInstallation: false,
    required: true,
  }));
  const calls = [
    async () => {
      const result = await preflightAgentRuntimeCredentials({
        ...owner,
        runtime,
      });
      expect(result).toEqual({
        configured: keys,
        missing: [],
        misconfigured: [],
      });
    },
    async () => {
      const result = await resolveAgentRuntimeCredentials({
        ...owner,
        runtime,
      });
      expect(result.env).toEqual(
        Object.fromEntries(keys.map((key) => [key, `example-${key}`])),
      );
      expect(result.missing).toEqual([]);
    },
    async () => {
      expect(
        await resolveMcpCredentialValues({
          ...owner,
          installationScope: "personal",
          environment,
        }),
      ).toEqual(Object.fromEntries(keys.map((key) => [key, `example-${key}`])));
    },
  ];
  for (const run of calls) {
    const { statements } = await recordQueries(run);
    expect(
      statements.filter((statement) =>
        statement.includes('from "credential_definitions"'),
      ),
    ).toHaveLength(1);
  }
  await RuntimeCredentialDefinitionModel.delete({
    organizationId: org.id,
    key: keys[0],
  });
  await expect(
    preflightAgentRuntimeCredentials({ ...owner, runtime }),
  ).rejects.toThrow("Credential is no longer available");
  await expect(
    resolveMcpCredentialValues({
      ...owner,
      installationScope: "personal",
      environment,
    }),
  ).rejects.toThrow("Credential is no longer available");
});

test("account runs need their own shared-credential grant and never inherit the creator's access", async ({
  makeOrganization,
  makeAdmin,
  makeMember,
  makeServiceAccount,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const human = await makeAdmin();
  await makeMember(human.id, org.id, { role: "admin" });
  const account = await makeServiceAccount(org.id);
  const agent = await makeAgent({ organizationId: org.id });
  const definition = await createRuntimeCredentialDefinition({
    organizationId: org.id,
    userId: human.id,
    initialGrants: [],
    definition: {
      key: "automation-secret",
      name: "Automation secret",
      description: "",
      icon: null,
      allowPersonal: false,
      allowOrganization: true,
    },
  });
  await setRuntimeCredentialConnection({
    organizationId: org.id,
    userId: human.id,
    credentialId: definition.key,
    scope: "organization",
    value: "shared-test-value",
  });
  const runtime = {
    agentId: agent.id,
    secretId: null,
    credentials: [
      {
        key: "AUTOMATION_SECRET",
        credentialId: definition.key,
        scope: "shared" as const,
        label: "Automation secret",
        required: true,
      },
    ],
  };
  const params = {
    runtime,
    organizationId: org.id,
    userId: null,
    authorizationUserId: serviceAccountUserId(account.id),
  };
  for (const resolve of [
    preflightAgentRuntimeCredentials,
    resolveAgentRuntimeCredentials,
  ])
    await expect(resolve(params)).rejects.toMatchObject({ statusCode: 403 });
  const policy = await ResourcePermissionPolicyModel.find({
    organizationId: org.id,
    resource: "credential",
    scope: definition.id,
  });
  if (!policy) throw new Error("Expected credential policy");
  await ResourcePermissionPolicyModel.replace({
    organizationId: org.id,
    resource: "credential",
    scope: definition.id,
    revision: policy.revision,
    grants: [
      ...policy.grants,
      {
        subject: { type: "serviceAccount", id: account.id },
        actions: ["read", "use"],
      },
    ],
  });
  expect((await resolveAgentRuntimeCredentials(params)).env).toEqual({
    AUTOMATION_SECRET: "shared-test-value",
  });
  expect((await preflightAgentRuntimeCredentials(params)).missing).toEqual([]);
});
