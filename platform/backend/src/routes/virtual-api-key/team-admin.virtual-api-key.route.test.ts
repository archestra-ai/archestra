import { createFastifyInstance } from "@/fastify-instance";
import MemberModel from "@/models/member";
import TeamModel from "@/models/team";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { ResourcePermissions } from "@/services/resource-permissions";
import { expect, test } from "@/test";
import { validatePassthroughVirtualKey } from "../proxy/llm-proxy-auth";
import virtualKeyRoutes from "./virtual-api-key.routes";

test("a lead manages eligible team keys and caps without gaining personal, sibling or stale access", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeTeamMember,
  makeVirtualApiKey,
  makeAgent,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const lead = await makeUser();
  const owner = await makeUser();
  let actor = lead;
  await makeMember(lead.id, org.id);
  await makeMember(owner.id, org.id);
  const parent = await makeTeam(org.id, lead.id);
  const child = await makeTeam(org.id, lead.id, { parentId: parent.id });
  const sibling = await makeTeam(org.id, lead.id);
  await makeTeamMember(parent.id, lead.id, { role: "admin" });
  await makeTeamMember(child.id, owner.id);
  const personal = await makeVirtualApiKey(org.id, {
    authorId: owner.id,
    access: "personal",
  });
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) =>
    Object.assign(request, {
      user: actor,
      organizationId: org.id,
      authMethod: "session",
    }),
  );
  await app.register(virtualKeyRoutes);
  try {
    const create = (billingTeamId?: string) =>
      app.inject({
        method: "POST",
        url: "/api/llm-virtual-keys",
        payload: {
          name: "Team member key",
          keyType: "passthrough",
          ownerId: owner.id,
          billingTeamId,
          spendCap: { limitValue: 5, cleanupInterval: "calendar_month" },
        },
      });
    const candidates = await MemberModel.findOptions({
      organizationId: org.id,
      viewerId: lead.id,
      canSeeAllMembers: false,
      pagination: { limit: 20 },
      searchMode: "name_or_email",
    });
    expect(candidates.data.map((row) => row.id)).toContain(owner.id);
    const created = await create(child.id);
    expect(created.statusCode, created.body).toBe(200);
    const key = created.json();
    expect(key.authorId).toBe(owner.id);
    expect(key).not.toHaveProperty("value");
    const reveal = () =>
      app.inject({
        method: "GET",
        url: `/api/llm-virtual-keys/${key.id}/value`,
      });
    expect((await reveal()).statusCode).toBe(403);
    const privateProxy = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
      access: "personal",
      agentType: "agent",
    });
    actor = owner;
    const ownerValue = await reveal();
    expect(ownerValue.statusCode).toBe(200);
    expect(
      (
        await validatePassthroughVirtualKey({
          tokenValue: ownerValue.json().value,
          agent: privateProxy,
        })
      ).userId,
    ).toBe(owner.id);
    actor = lead;
    const policyContext = {
      userId: lead.id,
      organizationId: org.id,
      resource: "llmVirtualKey" as const,
      scope: key.id,
    };
    const policy = await ResourcePermissions.getPolicy(policyContext);
    expect(policy.effectiveActions).not.toContain("manage-permissions");
    await expect(
      ResourcePermissions.updatePolicy({
        ...policyContext,
        revision: policy.revision,
        grants: [],
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const shared = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        keyType: "passthrough",
        name: "Retained access",
        ownerId: owner.id,
        billingTeamId: child.id,
        initialGrants: [
          {
            subject: { type: "user", id: lead.id },
            actions: ["read", "use", "update", "delete", "manage-permissions"],
          },
        ],
      },
    });
    expect(shared.statusCode).toBe(403);
    const update = (id: string) =>
      app.inject({
        method: "PATCH",
        url: `/api/llm-virtual-keys/${id}`,
        payload: {
          keyType: "passthrough",
          name: "Updated cap",
          spendCap: { limitValue: 10, cleanupInterval: "calendar_month" },
        },
      });
    expect((await update(key.id)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/llm-virtual-keys/${key.id}`,
        })
      ).json().spendCap.limitValue,
    ).toBe(10);
    const listed = await app.inject({
      method: "GET",
      url: "/api/llm-virtual-keys?access=mine,shared,org",
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data.map((row: { id: string }) => row.id)).toContain(
      key.id,
    );
    expect(
      listed.json().data.map((row: { id: string }) => row.id),
    ).not.toContain(personal.id);
    expect((await update(personal.id)).statusCode).toBe(403);
    expect((await create()).statusCode).toBe(403);
    expect((await create(sibling.id)).statusCode).toBe(403);
    await TeamModel.updateMemberRole({
      teamId: parent.id,
      userId: lead.id,
      role: "member",
    });
    expect((await update(key.id)).statusCode).toBe(403);
    expect((await reveal()).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/llm-virtual-keys/${key.id}`,
        })
      ).statusCode,
    ).toBe(404);
    expect(await VirtualApiKeyModel.findById(personal.id)).toMatchObject({
      billingTeamId: null,
    });
  } finally {
    await app.close();
  }
});

test("a lead edits a cap while retaining an owner's personal provider mapping, without acquiring or replacing its credential", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeTeamMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const org = await makeOrganization();
  const lead = await makeUser();
  const owner = await makeUser();
  await makeMember(lead.id, org.id);
  await makeMember(owner.id, org.id);
  const parent = await makeTeam(org.id, lead.id);
  const child = await makeTeam(org.id, lead.id, { parentId: parent.id });
  await makeTeamMember(parent.id, lead.id, { role: "admin" });
  await makeTeamMember(child.id, owner.id);
  const personalProvider = await makeLlmProviderApiKey(
    org.id,
    (await makeSecret({ secret: { apiKey: "gho_test_owner" } })).id,
    { provider: "github-copilot", userId: owner.id },
  );
  const replacement = await makeLlmProviderApiKey(
    org.id,
    (await makeSecret({ secret: { apiKey: "gho_test_replacement" } })).id,
    { provider: "github-copilot", userId: owner.id },
  );
  const { virtualKey } = await VirtualApiKeyModel.create({
    organizationId: org.id,
    name: "Member subscription",
    keyType: "standard",
    scope: "personal",
    authorId: owner.id,
    billingTeamId: child.id,
    providerApiKeys: [
      { provider: "github-copilot", providerApiKeyId: personalProvider.id },
    ],
  });
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) =>
    Object.assign(request, {
      user: lead,
      organizationId: org.id,
      authMethod: "session",
    }),
  );
  await app.register(virtualKeyRoutes);
  try {
    const patch = (providerApiKeyId: string, limitValue: number) =>
      app.inject({
        method: "PATCH",
        url: `/api/llm-virtual-keys/${virtualKey.id}`,
        payload: {
          name: virtualKey.name,
          keyType: "standard",
          providerApiKeys: [{ provider: "github-copilot", providerApiKeyId }],
          spendCap: { limitValue, cleanupInterval: "calendar_month" },
        },
      });
    const added = await patch(personalProvider.id, 5);
    expect(added.statusCode, added.body).toBe(200);
    const changed = await patch(personalProvider.id, 8);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().spendCap.limitValue).toBe(8);
    expect(changed.json()).not.toHaveProperty("value");
    expect((await patch(replacement.id, 9)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/llm-virtual-keys/${virtualKey.id}/value`,
        })
      ).statusCode,
    ).toBe(403);
    const sharedProvider = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "openai" },
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Member standard key",
        keyType: "standard",
        ownerId: owner.id,
        billingTeamId: child.id,
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: sharedProvider.id },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).not.toHaveProperty("value");
  } finally {
    await app.close();
  }
});
