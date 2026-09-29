import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { secretManager } from "@/secrets-manager";
import { beforeEach, expect, test } from "@/test";
import type { InternalMcpCatalog } from "@/types";
import { assertMcpRuntimeChangeAllowed } from "./mcp-runtime-authorization";

let original: InternalMcpCatalog;
let actor: { userId: string; organizationId: string };
beforeEach(
  async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    actor = { userId: user.id, organizationId: org.id };
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: user.id,
      access: "personal",
      serverType: "local",
      localConfig: { command: "node" },
    });
    original = (await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    })) as InternalMcpCatalog;
  },
);

test("an ordinary author can change generated unprivileged commands", async () => {
  await expect(
    assertMcpRuntimeChangeAllowed({
      ...actor,
      original,
      updates: { localConfig: { command: "python" } },
    }),
  ).resolves.toBeUndefined();
});

test("a scoped catalog author cannot select cluster privileges", async () => {
  for (const updates of [
    { localConfig: { command: "node", serviceAccount: "platform-account" } },
    {
      localConfig: {
        command: "node",
        envFrom: [{ type: "secret" as const, name: "platform-secret" }],
      },
    },
    {
      deploymentSpecYaml:
        "spec: {template: {spec: {serviceAccount: platform-account}}}",
    },
    {
      localConfig: {
        command: "node",
        imagePullSecrets: [
          { source: "existing" as const, name: "registry-secret" },
        ],
      },
    },
  ])
    await expect(
      assertMcpRuntimeChangeAllowed({ ...actor, original, updates }),
    ).rejects.toMatchObject({ statusCode: 403 });
});

test("keeping the selected account cannot authorize an executable change", async () => {
  original.localConfig = {
    command: "node",
    serviceAccount: "approved-account",
  };
  await expect(
    assertMcpRuntimeChangeAllowed({
      ...actor,
      original,
      updates: { localConfig: { ...original.localConfig, command: "sh" } },
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    assertMcpRuntimeChangeAllowed({
      ...actor,
      original,
      updates: { localConfig: { command: "sh" } },
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    assertMcpRuntimeChangeAllowed({
      ...actor,
      original,
      updates: { name: "new-runtime-name" },
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
});

test("metadata edits and unchanged hydrated configuration are permitted", async () => {
  const bag = await secretManager().createSecret(
    { TOKEN: "approved-value" },
    "catalog-secret",
  );
  original.localConfigSecretId = bag.id;
  original.localConfig = {
    command: "node",
    serviceAccount: "approved-account",
    environment: [
      { key: "TOKEN", type: "secret", promptOnInstallation: false },
    ],
  };
  await expect(
    assertMcpRuntimeChangeAllowed({
      ...actor,
      original,
      updates: {
        description: "Changed description",
        localConfig: {
          ...original.localConfig,
          environment: [
            {
              key: "TOKEN",
              type: "secret",
              promptOnInstallation: false,
              value: "approved-value",
            },
          ],
        },
      },
    }),
  ).resolves.toBeUndefined();
  await expect(
    assertMcpRuntimeChangeAllowed({
      ...actor,
      original,
      updates: {
        localConfig: {
          ...original.localConfig,
          environment: [
            {
              key: "TOKEN",
              type: "secret",
              promptOnInstallation: false,
              value: "changed-value",
            },
          ],
        },
      },
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
});

test("delegated registry-wide administrators can choose custom accounts", async () => {
  const key = {
    organizationId: actor.organizationId,
    resource: "mcpRegistry" as const,
    scope: "*" as const,
  };
  const current = await ResourcePermissionPolicyModel.find(key);
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: current?.revision ?? 0,
    grants: [
      ...(current?.grants ?? []),
      { subject: { type: "user", id: actor.userId }, actions: ["update"] },
    ],
  });
  await expect(
    assertMcpRuntimeChangeAllowed({
      ...actor,
      original,
      updates: {
        localConfig: { command: "node", serviceAccount: "approved-account" },
      },
    }),
  ).resolves.toBeUndefined();
});

test("an ordinary author can supply their own registry credentials", async () => {
  await expect(
    assertMcpRuntimeChangeAllowed({
      ...actor,
      original,
      updates: {
        localConfig: {
          command: "node",
          imagePullSecrets: [
            {
              source: "credentials",
              server: "registry.example",
              username: "author",
              password: "their-password",
            },
          ],
        },
      },
    }),
  ).resolves.toBeUndefined();
});

test("unchanged legacy inline secrets and environment descriptions remain editable", async () => {
  original.localConfig = {
    command: "node",
    serviceAccount: "approved-account",
    environment: [
      {
        key: "TOKEN",
        type: "secret",
        promptOnInstallation: false,
        value: "legacy-value",
        description: "old hint",
      },
    ],
  };
  await expect(
    assertMcpRuntimeChangeAllowed({
      ...actor,
      original,
      updates: {
        localConfig: {
          ...original.localConfig,
          environment: [
            {
              key: "TOKEN",
              type: "secret",
              promptOnInstallation: false,
              value: "legacy-value",
              description: "new hint",
            },
          ],
        },
      },
    }),
  ).resolves.toBeUndefined();
  await expect(
    assertMcpRuntimeChangeAllowed({
      ...actor,
      original,
      updates: {
        localConfig: {
          ...original.localConfig,
          environment: [
            {
              key: "TOKEN",
              type: "secret",
              promptOnInstallation: false,
              value: "changed-value",
            },
          ],
        },
      },
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
});

test("legacy default runtime fields echoed by the form do not require elevated authoring", async () => {
  original.localConfig = {
    command: "node",
    serviceAccount: "approved-account",
  };
  await expect(
    assertMcpRuntimeChangeAllowed({
      ...actor,
      original,
      updates: {
        localConfig: {
          ...original.localConfig,
          transportType: "stdio",
          httpPort: 8080,
          httpPath: "/mcp",
          environment: [],
          arguments: [],
          envFrom: [],
          imagePullSecrets: [],
        },
      },
    }),
  ).resolves.toBeUndefined();
});
