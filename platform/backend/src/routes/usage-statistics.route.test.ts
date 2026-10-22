import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { betterAuth } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin/plugin";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import McpToolCallModel from "@/models/mcp-tool-call";
import ServiceAccountModel from "@/models/service-account";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import routes from "./statistics";

const RANGE = "custom:2026-09-30T00:00:00.000Z_2026-10-03T00:00:00.000Z";
const DAY = new Date("2026-10-01T12:00:00Z");
const endpoints = ["mcp-tool-calls", "app-usage", "skill-usage"] as const;

describe("grouped usage authorization", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let role: string;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeCustomRole,
      makeMember,
      makeSession,
    }) => {
      organizationId = (await makeOrganization()).id;
      user = await makeUser();
      role = (
        await makeCustomRole(organizationId, {
          permission: { llmCost: ["read"], app: ["read"], skill: ["read"] },
        })
      ).role;
      await makeMember(user.id, organizationId, { role });
      const session = await makeSession(user.id, {
        activeOrganizationId: organizationId,
      });
      vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
        response: { user, session },
        headers: new Headers(),
      } as never);
      app = createFastifyInstance();
      await app.register(authPlugin);
      await app.register(routes);
    },
  );

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  test.each(
    endpoints,
  )("%s rejects unauthenticated requests", async (endpoint) => {
    vi.mocked(betterAuth.api.getSession).mockResolvedValue({
      response: null,
      headers: new Headers(),
    } as never);
    const response = await app.inject({
      method: "GET",
      url: `/api/statistics/${endpoint}`,
    });
    expect(response.statusCode, response.body).toBe(401);
  });

  test.each(endpoints)("%s requires cost read permission", async (endpoint) => {
    await db
      .update(schema.organizationRolesTable)
      .set({ permission: JSON.stringify({ app: ["read"], skill: ["read"] }) })
      .where(eq(schema.organizationRolesTable.role, role));
    const response = await app.inject({
      method: "GET",
      url: `/api/statistics/${endpoint}`,
    });
    expect(response.statusCode, response.body).toBe(403);
  });

  test.each([
    "app-usage",
    "skill-usage",
  ] as const)("%s requires its resource read permission", async (endpoint) => {
    await db
      .update(schema.organizationRolesTable)
      .set({ permission: JSON.stringify({ llmCost: ["read"] }) })
      .where(eq(schema.organizationRolesTable.role, role));
    const response = await app.inject({
      method: "GET",
      url: `/api/statistics/${endpoint}`,
    });
    expect(response.statusCode, response.body).toBe(403);
  });

  test("resource visibility and member permission narrow rows and totals", async ({
    makeUser,
    makeApp,
    makeSkill,
  }) => {
    const other = await makeUser();
    const visible = await makeApp({
      organizationId,
      authorId: user.id,
      access: "personal",
    });
    const hidden = await makeApp({
      organizationId,
      authorId: other.id,
      access: "personal",
    });
    const skill = await makeSkill(organizationId, {
      authorId: user.id,
      access: "personal",
    });
    const hiddenSkill = await makeSkill(organizationId, {
      authorId: other.id,
      access: "personal",
    });
    for (const [appId, userId] of [
      [visible.id, user.id],
      [visible.id, other.id],
      [hidden.id, user.id],
    ]) {
      await McpToolCallModel.create({
        ownerType: "app",
        appId,
        agentId: null,
        userId,
        mcpServerName: "sample",
        method: "tools/list",
        toolCall: null,
        toolResult: { tools: [] },
        authMethod: null,
        createdAt: DAY,
      });
    }
    await db.insert(schema.skillUsageEventsTable).values([
      { skillId: skill.id, userId: user.id, contextTokens: 10, createdAt: DAY },
      {
        skillId: skill.id,
        userId: other.id,
        contextTokens: 20,
        createdAt: DAY,
      },
      {
        skillId: hiddenSkill.id,
        userId: user.id,
        contextTokens: 30,
        createdAt: DAY,
      },
    ]);
    for (const [endpoint, expectedId, idField, metric] of [
      ["app-usage", visible.id, "appId", "runs"],
      ["skill-usage", skill.id, "skillId", "activations"],
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/statistics/${endpoint}?timeframe=${RANGE}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual([
        expect.objectContaining({ [idField]: expectedId, [metric]: 1 }),
      ]);
      expect(response.json().totals[metric]).toBe(1);
      const spoofed = await app.inject({
        method: "GET",
        url: `/api/statistics/${endpoint}?timeframe=${RANGE}&userId=${other.id}`,
      });
      expect(spoofed.statusCode, spoofed.body).toBe(200);
      expect(spoofed.json().data).toEqual([]);
      expect(spoofed.json().totals[metric]).toBe(0);
    }
  });

  test("service-account tokens obey their role's permission boundary", async ({
    makeServiceAccount,
  }) => {
    vi.mocked(betterAuth.api.getSession).mockResolvedValue({
      response: null,
      headers: new Headers(),
    } as never);
    const account = await makeServiceAccount(organizationId, { role });
    const { token } = await ServiceAccountModel.createToken({
      organizationId,
      serviceAccountId: account.id,
      name: "Usage report",
    });
    for (const endpoint of endpoints) {
      const response = await app.inject({
        method: "GET",
        url: `/api/statistics/${endpoint}`,
        headers: { authorization: token },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual([]);
    }
  });
});
