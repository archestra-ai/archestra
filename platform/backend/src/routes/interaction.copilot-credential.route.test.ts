import { randomUUID } from "node:crypto";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import InteractionModel from "@/models/interaction";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import { encodeGithubAppReference } from "@/services/github-app-copilot-token";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GitHub Copilot credential source in the logs", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeOrganization, makeMember }) => {
    currentUser = await makeAdmin();
    organizationId = (await makeOrganization()).id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: currentUser, organizationId });
    });
    const { default: interactionRoutes } = await import("./interaction");
    await app.register(interactionRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("names the organization subscription or the personal sign-in", async ({
    makeAgent,
    makeSecret,
  }) => {
    const agent = await makeAgent({ organizationId });
    // A plan key stores a reference to its GitHub App credential.
    const appValue = encodeGithubAppReference({
      ref: { organizationId, credentialId: randomUUID() },
      installationId: "2",
      organization: "my-org",
      githubUrl: "https://github.com",
    });
    const appKey = await LlmProviderApiKeyModel.create(
      {
        organizationId,
        name: "GitHub Copilot (my-org)",
        provider: "github-copilot",
        secretId: (await makeSecret({ secret: { apiKey: appValue } })).id,
        scope: "org",
        userId: null,
      },
      { apiKeyValue: appValue },
    );
    const personalKey = await LlmProviderApiKeyModel.create(
      {
        organizationId,
        name: "GitHub Copilot",
        provider: "github-copilot",
        secretId: (await makeSecret({ secret: { apiKey: "gho_me" } })).id,
        scope: "personal",
        userId: currentUser.id,
      },
      { apiKeyValue: "gho_me" },
    );
    const record = (keyId: string, sessionId: string) =>
      InteractionModel.create({
        profileId: agent.id,
        sessionId,
        model: "gpt-4o",
        request: { model: "gpt-4o", messages: [] },
        response: {
          id: "r",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4o",
          choices: [],
        },
        type: "github-copilot:chatCompletions",
        providerApiKeyId: keyId,
      });
    const orgRow = await record(appKey.id, "org-session");
    const personalRow = await record(personalKey.id, "personal-session");

    const orgDetail = await app.inject({
      method: "GET",
      url: `/api/interactions/${orgRow.id}`,
    });
    expect(orgDetail.json().copilotCredentialSource).toEqual({
      kind: "organization",
      organization: "my-org",
    });
    const personalDetail = await app.inject({
      method: "GET",
      url: `/api/interactions/${personalRow.id}`,
    });
    expect(personalDetail.json().copilotCredentialSource).toEqual({
      kind: "personal",
    });

    const sessions = await app.inject({
      method: "GET",
      url: "/api/interactions/sessions",
    });
    const bySession = Object.fromEntries(
      (
        sessions.json().data as Array<{
          sessionId: string;
          copilotCredentialSources: unknown;
        }>
      ).map((row) => [row.sessionId, row.copilotCredentialSources]),
    );
    expect(bySession["org-session"]).toEqual([
      { kind: "organization", organization: "my-org" },
    ]);
    expect(bySession["personal-session"]).toEqual([{ kind: "personal" }]);
  });
});
