import { generateKeyPairSync } from "node:crypto";
import type { V1Secret } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  GithubAppConfigModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { AGENT_RUNTIME_CREDENTIALS_SECRET_KEY } from "@/services/agent-runtime/runtime-contract";
import { expect, test } from "@/test";
import { useMswServer as setupMswServer } from "@/test/msw";
import manager from "./manager";

const server = setupMswServer();

test("refreshes the frozen run binding and cannot restore a concurrently revoked Secret", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: organization.id });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  const run = await AgentRunModel.create({
    organizationId: organization.id,
    agentId: agent.id,
    taskId: task.id,
    actorKind: "user",
    actorId: user.id,
    actorUserId: user.id,
    backend: "kubernetes",
    runtimeScope: "local",
    workloadName: "refresh-test",
  });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const secret = await secretManager().createSecret(
    { apiToken: privateKey },
    "refresh-app",
  );
  const app = await GithubAppConfigModel.create({
    organizationId: organization.id,
    name: "Repository App",
    githubUrl: "https://api.github.com",
    appId: "123",
    installationId: "123456789",
    secretId: secret.id,
  });
  let exchanges = 0;
  const expiresAt = Date.now() + 60 * 60_000;
  server.use(
    http.post(
      "https://api.github.com/app/installations/123456789/access_tokens",
      () => {
        exchanges++;
        return HttpResponse.json({
          token: "renewed-installation-token",
          expires_at: new Date(expiresAt).toISOString(),
        });
      },
    ),
  );
  const bundle = {
    taskId: task.id,
    credentials: {
      GITHUB_TOKEN: {
        credentialId: `github-app.${app.id}`,
        value: "old-token",
        expiresAt: Date.now() + 60_000,
      },
    },
  };
  let stored: V1Secret = {
    metadata: { resourceVersion: "1" },
    data: {
      [AGENT_RUNTIME_CREDENTIALS_SECRET_KEY]: Buffer.from(
        JSON.stringify(bundle),
      ).toString("base64"),
    },
  };
  let revokeDuringWrite = false;
  let writes = 0;
  const internals = manager as unknown as { clients: unknown };
  const original = internals.clients;
  internals.clients = {
    coreApi: {
      readNamespacedSecret: async () => structuredClone(stored),
      patchNamespacedSecret: async ({ body }: { body: V1Secret }) => {
        if (revokeDuringWrite) {
          stored = {
            metadata: { resourceVersion: "3" },
            data: { [AGENT_RUNTIME_CREDENTIALS_SECRET_KEY]: "" },
          };
          throw { statusCode: 409 };
        }
        expect(body.metadata?.resourceVersion).toBe(
          stored.metadata?.resourceVersion,
        );
        writes++;
        stored = {
          metadata: { resourceVersion: "2" },
          data: {
            [AGENT_RUNTIME_CREDENTIALS_SECRET_KEY]: Buffer.from(
              body.stringData?.[AGENT_RUNTIME_CREDENTIALS_SECRET_KEY] ?? "",
            ).toString("base64"),
          },
        };
      },
    },
  };
  try {
    await manager.refreshCredentials(run);
    const result = Buffer.from(
      stored.data?.[AGENT_RUNTIME_CREDENTIALS_SECRET_KEY] ?? "",
      "base64",
    ).toString();
    expect(JSON.parse(result).credentials.GITHUB_TOKEN).toEqual({
      credentialId: `github-app.${app.id}`,
      value: "renewed-installation-token",
      expiresAt,
    });
    expect(result).not.toContain("PRIVATE KEY");
    await manager.refreshCredentials(run);
    expect(exchanges).toBe(1);
    expect(writes).toBe(1);
    stored.data = {
      [AGENT_RUNTIME_CREDENTIALS_SECRET_KEY]: Buffer.from(
        JSON.stringify(bundle),
      ).toString("base64"),
    };
    revokeDuringWrite = true;
    await manager.refreshCredentials(run);
    await manager.refreshCredentials(run);
    expect(stored.data?.[AGENT_RUNTIME_CREDENTIALS_SECRET_KEY]).toBe("");
    expect(writes).toBe(1);
  } finally {
    internals.clients = original;
  }
});
