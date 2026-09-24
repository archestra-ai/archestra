// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { vi } from "vitest";
import { betterAuth, hasPermission, userHasPermission } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin";
import { createFastifyInstance } from "@/fastify-instance";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { expect, test } from "@/test";
import providerRoutes from "./llm-provider-api-keys";
import virtualRoutes from "./virtual-api-key/virtual-api-key.routes";

vi.mock("@/auth");

test("real middleware admits scoped editors without role update permission and rejects viewers", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeSecret,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  const editor = await makeUser();
  const viewer = await makeUser();
  for (const user of [owner, editor, viewer]) await makeMember(user.id, org.id);
  const grants = [
    {
      subject: { type: "user" as const, id: editor.id },
      actions: ["read" as const, "update" as const],
    },
    {
      subject: { type: "user" as const, id: viewer.id },
      actions: ["read" as const],
    },
  ];
  const secret = await makeSecret({ secret: { apiKey: "sk-test" } });
  const provider = await LlmProviderApiKeyModel.create(
    {
      organizationId: org.id,
      name: "Provider",
      provider: "openai",
      scope: "personal",
      userId: owner.id,
      secretId: secret.id,
    },
    { initialPermissionGrants: grants },
  );
  const { virtualKey } = await VirtualApiKeyModel.create({
    organizationId: org.id,
    name: "Virtual",
    scope: "personal",
    authorId: owner.id,
    providerApiKeys: [{ provider: "openai", providerApiKeyId: provider.id }],
    initialPermissionGrants: grants,
  });
  vi.mocked(hasPermission).mockResolvedValue({
    success: false,
    error: new Error("Role cannot update keys"),
  });
  vi.mocked(userHasPermission).mockResolvedValue(false);
  const app = createFastifyInstance();
  await app.register(authPlugin);
  await app.register(providerRoutes);
  await app.register(virtualRoutes);
  try {
    for (const actor of [editor, viewer]) {
      vi.mocked(betterAuth.api.getSession).mockResolvedValue({
        response: {
          user: { id: actor.id },
          session: { activeOrganizationId: org.id },
        },
        headers: new Headers(),
      } as unknown as Awaited<ReturnType<typeof betterAuth.api.getSession>>);
      for (const target of [
        {
          url: `/api/llm-provider-api-keys/${provider.id}`,
          body: { name: "Renamed", scope: "personal" },
        },
        {
          url: `/api/llm-virtual-keys/${virtualKey.id}`,
          body: {
            name: "Renamed",
            scope: "personal",
            providerApiKeys: [
              { provider: "openai", providerApiKeyId: provider.id },
            ],
          },
        },
      ]) {
        const read = await app.inject({ method: "GET", url: target.url });
        expect(read.statusCode, read.body).toBe(200);
        const update = await app.inject({
          method: "PATCH",
          url: target.url,
          payload: target.body,
        });
        expect(update.statusCode, update.body).toBe(
          actor.id === editor.id ? 200 : 403,
        );
        expect(
          (await app.inject({ method: "DELETE", url: target.url })).statusCode,
        ).toBe(403);
      }
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/llm-virtual-keys/${virtualKey.id}/value`,
          })
        ).statusCode,
      ).toBe(403);
    }
    expect((await LlmProviderApiKeyModel.findById(provider.id))?.userId).toBe(
      owner.id,
    );
    expect(
      (await VirtualApiKeyModel.findAccessContextById(virtualKey.id))?.authorId,
    ).toBe(owner.id);
  } finally {
    await app.close();
  }
});
