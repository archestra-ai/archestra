import { generateKeyPairSync, randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import {
  GithubAppConfigModel,
  KnowledgeBaseConnectorModel,
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import GithubPatModel from "@/models/github-pat";
import { secretManager } from "@/secrets-manager";
import {
  createRuntimeCredentialDefinition,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import { updateGithubPat } from "@/services/github-pat";
import { resolveGithubPatToken } from "@/skills/github-app-token";
import { expect, test } from "@/test";
import { useMswServer as setupMswServer } from "@/test/msw";
import {
  resolveCredentialValue,
  resolveMcpCredentialValues,
} from "./credentials";

const server = setupMswServer();

test("deleted Knowledge connectors no longer prevent deleting a shared credential", async ({
  makeOrganization,
  makeUser,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const definition = await createRuntimeCredentialDefinition({
    organizationId: organization.id,
    userId: user.id,
    definition: {
      key: "knowledge-access",
      name: "Knowledge access",
      kind: "secret",
      description: "",
      icon: null,
      allowPersonal: false,
      allowOrganization: true,
    },
  });
  const knowledgeBase = await makeKnowledgeBase(organization.id);
  const connector = await makeKnowledgeBaseConnector(
    knowledgeBase.id,
    organization.id,
    {
      connectorType: "github",
      config: {
        type: "github",
        owner: "example",
        githubUrl: "https://api.github.com",
        authMethod: "credential",
        credentialId: definition.key,
      },
    },
  );
  const params = { organizationId: organization.id, key: definition.key };
  expect(await RuntimeCredentialDefinitionModel.listOtherUsage(params)).toEqual(
    [{ id: connector.id, name: connector.name, kind: "knowledge" }],
  );
  await KnowledgeBaseConnectorModel.delete(connector.id);
  expect(await RuntimeCredentialDefinitionModel.listOtherUsage(params)).toEqual(
    [],
  );
});

test("reuses one personal value across runtime and MCP without sharing another user's connection", async ({
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const other = await makeUser();
  const owner = { organizationId: organization.id, userId: user.id };
  await createRuntimeCredentialDefinition({
    ...owner,
    definition: {
      key: "repository",
      name: "Repository",
      description: "",
      icon: null,
      allowPersonal: true,
      allowOrganization: false,
    },
  });
  await setRuntimeCredentialConnection({
    ...owner,
    credentialId: "repository",
    scope: "personal",
    value: "one-private-token",
  });
  expect(
    await resolveCredentialValue({
      ...owner,
      credentialId: "repository",
      scope: "personal",
    }),
  ).toBe("one-private-token");
  const environment = [
    {
      key: "GITHUB_TOKEN",
      type: "secret",
      credentialId: "repository",
      credentialScope: "personal" as const,
      promptOnInstallation: false,
      required: true,
    },
  ];
  expect(
    await resolveMcpCredentialValues({
      ...owner,
      environment,
      installationScope: "personal",
    }),
  ).toEqual({ GITHUB_TOKEN: "one-private-token" });
  await expect(
    resolveMcpCredentialValues({
      ...owner,
      userId: other.id,
      environment,
      installationScope: "personal",
    }),
  ).rejects.toThrow("Connect the credential");
  await expect(
    resolveMcpCredentialValues({
      ...owner,
      environment,
      installationScope: "org",
    }),
  ).rejects.toThrow("personal MCP installation");
  await expect(
    resolveCredentialValue({
      ...owner,
      credentialId: "repository",
      scope: "organization",
    }),
  ).rejects.toThrow("ownership");
});

test("existing GitHub PAT consumers and MCP resolve the same secret handle", async ({
  makeOrganization,
}) => {
  const organization = await makeOrganization();
  const secret = await secretManager().createSecret(
    { apiToken: "shared-pat" },
    "test-pat",
  );
  const pat = await GithubPatModel.create({
    organizationId: organization.id,
    name: "Repository",
    secretId: secret.id,
  });
  const params = {
    organizationId: organization.id,
    userId: null,
    installationScope: "org",
    environment: [
      {
        key: "GITHUB_TOKEN",
        type: "secret",
        credentialId: `secret.${pat.id}`,
        credentialScope: "organization" as const,
        promptOnInstallation: false,
        required: true,
      },
    ],
  };
  expect(await resolveMcpCredentialValues(params)).toEqual({
    GITHUB_TOKEN: "shared-pat",
  });
  await secretManager().updateSecret(secret.id, { apiToken: "rotated-pat" });
  expect(await resolveMcpCredentialValues(params)).toEqual({
    GITHUB_TOKEN: "rotated-pat",
  });
});

test("GitHub Apps deliver installation tokens rather than private keys", async ({
  makeOrganization,
}) => {
  const organization = await makeOrganization();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const installationId = randomUUID();
  server.use(
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      ({ request }) => {
        expect(request.headers.get("Authorization")).toMatch(/^Bearer ey/);
        return HttpResponse.json({
          token: "short-lived-installation-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      },
    ),
  );
  const secret = await secretManager().createSecret(
    { apiToken: privateKey },
    "test-app",
  );
  const app = await GithubAppConfigModel.create({
    organizationId: organization.id,
    name: "Repository App",
    githubUrl: "https://api.github.com",
    appId: "123",
    installationId,
    secretId: secret.id,
  });
  expect(
    await resolveCredentialValue({
      organizationId: organization.id,
      credentialId: `github-app.${app.id}`,
      scope: "organization",
    }),
  ).toBe("short-lived-installation-token");
  expect(
    await resolveMcpCredentialValues({
      organizationId: organization.id,
      userId: null,
      installationScope: "org",
      environment: [
        {
          key: "GITHUB_TOKEN",
          type: "secret",
          credentialId: `github-app.${app.id}`,
          credentialScope: "organization" as const,
          promptOnInstallation: false,
          required: true,
        },
      ],
    }),
  ).toEqual({ GITHUB_TOKEN: "short-lived-installation-token" });
});

test("GitHub import resolves an ordinary custom secret after a name-only edit", async ({
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const owner = { organizationId: organization.id, userId: user.id };
  const definition = await createRuntimeCredentialDefinition({
    ...owner,
    definition: {
      key: "repository-secret",
      name: "Repository access",
      kind: "secret",
      description: "",
      icon: null,
      allowPersonal: false,
      allowOrganization: true,
    },
  });
  await setRuntimeCredentialConnection({
    ...owner,
    credentialId: definition.key,
    scope: "organization",
    value: "saved-once",
  });
  await updateGithubPat({
    organizationId: organization.id,
    id: definition.id,
    data: { name: "Renamed access" },
  });
  expect(
    await resolveGithubPatToken({
      organizationId: organization.id,
      githubPatId: definition.id,
    }),
  ).toBe("saved-once");
  expect(
    await resolveCredentialValue({
      organizationId: organization.id,
      credentialId: definition.key,
      scope: "organization",
    }),
  ).toBe("saved-once");
});

test("connection status remains scoped to the requested organization", async ({
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const otherOrganization = await makeOrganization();
  const user = await makeUser();
  await RuntimeCredentialConnectionModel.upsert({
    organizationId: otherOrganization.id,
    userId: user.id,
    scope: "personal",
    credentialId: "repository",
    value: "other-organization-value",
  });
  expect(
    await RuntimeCredentialConnectionModel.listConfigured({
      organizationId: organization.id,
      userId: user.id,
    }),
  ).toEqual([]);
});
