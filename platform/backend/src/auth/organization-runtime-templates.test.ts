import { randomUUID } from "node:crypto";
import { buildCustomAgentRuntime } from "@archestra/shared";
import { makeSignature } from "better-auth/crypto";
import db, { schema } from "@/database";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import OrganizationModel from "@/models/organization";
import SecretModel from "@/models/secret";
import { expect, test } from "@/test";
import { auth } from "./better-auth";

test("organization deletion removes only its runtime templates and cannot resurrect them", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeSession,
}) => {
  const organization = await makeOrganization();
  const other = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, organization.id, { role: "admin" });
  const session = await makeSession(admin.id, {
    activeOrganizationId: organization.id,
  });
  const template = {
    id: randomUUID(),
    name: "Private workspace",
    description: "",
    icon: null,
    hidden: false,
    position: 0,
    runtime: {
      ...buildCustomAgentRuntime({
        image: "registry.example.com/workspace:v1",
      }),
      privileged: false as const,
      environment: [
        { key: "PRIVATE_SETTING", value: "organization-private-value" },
      ],
    },
  };
  for (const organizationId of [organization.id, other.id]) {
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId,
      settings: { revision: 0, templates: [template] },
      popularAgentOverrides: null,
    });
  }
  const signature = await makeSignature(
    session.token,
    process.env.ARCHESTRA_AUTH_SECRET as string,
  );
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/organization/delete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        cookie: `archestra.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`,
      },
      body: JSON.stringify({ organizationId: organization.id }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await OrganizationModel.getById(organization.id)).toBeNull();
  expect(
    await SecretModel.findByName(`agent-runtime-templates:${organization.id}`),
  ).toBeNull();
  expect(
    (await AgentRuntimeTemplateModel.getSettings(other.id)).templates,
  ).toEqual([template]);
  await db.insert(schema.organizationsTable).values({
    id: organization.id,
    name: "Recreated organization",
    slug: organization.slug,
    createdAt: new Date(),
  });
  expect(await AgentRuntimeTemplateModel.getSettings(organization.id)).toEqual({
    revision: 0,
    templates: [],
    popularAgentOverrides: null,
  });
});
