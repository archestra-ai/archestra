import { vi } from "vitest";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  userHasPermission: vi.fn(),
}));

import { userHasPermission } from "@/auth";

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("virtualApiKeysRoutes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    mockUserHasPermission.mockReset();
    mockUserHasPermission.mockResolvedValue(false);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: virtualApiKeysRoutes } = await import(
      "./virtual-api-keys"
    );
    await app.register(virtualApiKeysRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("GET /api/llm-virtual-keys returns only virtual keys visible to the current user", async ({
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const owner = user;
    const outsider = await makeUser();
    const outsiderOrg = await makeOrganization();
    const team = await makeTeam(organizationId, owner.id, {
      name: "Platform Team",
    });
    const outsiderTeam = await makeTeam(organizationId, outsider.id, {
      name: "Other Team",
    });
    await makeTeamMember(team.id, owner.id);
    await makeTeamMember(outsiderTeam.id, outsider.id);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const outsiderSecret = await makeSecret({ secret: { apiKey: "sk-other" } });
    const outsiderOrgKey = await makeLlmProviderApiKey(
      outsiderOrg.id,
      outsiderSecret.id,
    );

    await VirtualApiKeyModel.create({
      chatApiKeyId: parentKey.id,
      name: "Org Visible",
      scope: "org",
      authorId: owner.id,
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: parentKey.id,
      name: "My Personal",
      scope: "personal",
      authorId: owner.id,
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: parentKey.id,
      name: "Other Personal",
      scope: "personal",
      authorId: outsider.id,
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: parentKey.id,
      name: "Team Visible",
      scope: "team",
      authorId: owner.id,
      teamIds: [team.id],
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: parentKey.id,
      name: "Other Team Key",
      scope: "team",
      authorId: outsider.id,
      teamIds: [outsiderTeam.id],
    });
    await VirtualApiKeyModel.create({
      chatApiKeyId: outsiderOrgKey.id,
      name: "Different Org Key",
      scope: "org",
      authorId: outsider.id,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/llm-virtual-keys",
    });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json();
    const names = responseBody.data.map((item: { name: string }) => item.name);
    expect(names).toEqual(
      expect.arrayContaining(["Org Visible", "My Personal", "Team Visible"]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "Other Personal",
        "Other Team Key",
        "Different Org Key",
      ]),
    );
  });

  test("GET /api/llm-virtual-keys includes org-scoped keys for llmVirtualKey admins", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);

    await VirtualApiKeyModel.create({
      chatApiKeyId: parentKey.id,
      name: "Admin Visible",
      scope: "org",
      authorId: user.id,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/llm-virtual-keys",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Admin Visible", scope: "org" }),
      ]),
    );
  });

  test("POST /api/llm-provider-api-keys/:id/virtual-keys rejects org scope without llmVirtualKey admin", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/llm-provider-api-keys/${parentKey.id}/virtual-keys`,
      payload: {
        name: "Org Key",
        scope: "org",
        teams: [],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        message:
          "You need llmVirtualKey:admin permission to create org-scoped virtual keys",
      },
    });
  });

  test("POST /api/llm-provider-api-keys/:id/virtual-keys allows llmVirtualKey admins to assign any team", async ({
    makeLlmProviderApiKey,
    makeSecret,
    makeTeam,
    makeUser,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const otherOwner = await makeUser();
    const otherTeam = await makeTeam(organizationId, otherOwner.id, {
      name: "Other Team",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/llm-provider-api-keys/${parentKey.id}/virtual-keys`,
      payload: {
        name: "Team Key",
        scope: "team",
        teams: [otherTeam.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Team Key",
      scope: "team",
      teams: [expect.objectContaining({ id: otherTeam.id })],
    });
  });
});
