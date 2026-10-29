// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import type { User } from "@/types";
import routes from "./agent";

vi.mock("@/observability");

/**
 * The MCP gateways page lists gateways and profiles three ways at once: the
 * table page, the viewer's pins and the automatic pins. Each list reads a
 * fixed set of statements however many agents the organization shares with
 * the viewer, and the organization's other members' personal gateways stay
 * out of the viewer's default Show selection.
 */
describe("MCP gateways page lists", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let caller: User;
  let admin: User;
  let member: User;
  let teamId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      organizationId = org.id;
      await db.transaction((tx) =>
        ResourcePermissionPolicyModel.initializeOrganization({
          tx,
          organizationId,
        }),
      );
      admin = await makeUser();
      await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
      member = await makeUser();
      await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });
      const team = await makeTeam(organizationId, admin.id);
      teamId = team.id;
      await makeTeamMember(team.id, member.id);
      caller = admin;
      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        request.user = caller;
        request.organizationId = organizationId;
      });
      await app.register(routes);
    },
  );
  afterEach(async () => {
    await app.close();
  });

  test("each list reads the same statements and rows however many agents are shared", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const seed = async (count: number) => {
      for (let index = 0; index < count; index++) {
        await makeAgent({
          organizationId,
          agentType: index % 2 ? "mcp_gateway" : "profile",
          access: "org",
        });
        await makeAgent({
          organizationId,
          agentType: "mcp_gateway",
          access: { teams: [teamId], level: "use" },
        });
        const other = await makeUser();
        await makeMember(other.id, organizationId, { role: MEMBER_ROLE_NAME });
        await makeAgent({
          organizationId,
          authorId: other.id,
          agentType: "mcp_gateway",
          access: "personal",
        });
      }
    };
    const reads = async () => {
      const counts: Record<string, { statements: number; rows: number }> = {};
      for (const user of [admin, member]) {
        caller = user;
        for (const [name, url] of Object.entries(pageUrls())) {
          const { result, statements, rowCounts } = await recordQueries(() =>
            app.inject({ method: "GET", url }),
          );
          expect(result.statusCode, result.body).toBe(200);
          counts[`${user === admin ? "admin" : "member"} ${name}`] = {
            statements: statements.length,
            rows: rowCounts.reduce((total, rows) => total + rows, 0),
          };
        }
      }
      return counts;
    };

    // Both sizes fill the table's page for both callers, so only reads that
    // grow with the shared agents could tell them apart.
    await seed(12);
    const fewer = await reads();
    await seed(12);
    expect(await reads()).toEqual(fewer);
  });

  test("admins and members see their own, shared and organization gateways, newest first, without others' personal ones", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const other = await makeUser();
    await makeMember(other.id, organizationId, { role: MEMBER_ROLE_NAME });
    const othersPersonal = await makeAgent({
      organizationId,
      authorId: other.id,
      agentType: "mcp_gateway",
      access: "personal",
    });
    const orgProfile = await makeAgent({
      organizationId,
      agentType: "profile",
      access: "org",
    });
    const teamGateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      access: { teams: [teamId], level: "use" },
    });
    const membersOwn = await makeAgent({
      organizationId,
      authorId: member.id,
      agentType: "mcp_gateway",
      access: "personal",
    });
    const sharedWithMember = await makeAgent({
      organizationId,
      authorId: other.id,
      agentType: "mcp_gateway",
      access: { users: [member.id], preset: "view" },
    });
    for (const [agent, day] of [
      [orgProfile, 1],
      [teamGateway, 2],
      [membersOwn, 3],
      [sharedWithMember, 4],
    ] as const)
      await createdOn(agent.id, new Date(Date.UTC(2026, 0, day)));

    const listed = async (user: User) => {
      caller = user;
      const response = await app.inject({
        method: "GET",
        url: pageUrls().table,
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      return {
        ids: body.data.map((agent: { id: string }) => agent.id),
        total: body.pagination.total,
      };
    };

    // The member's own gateway leads, then the rest newest first.
    expect(await listed(member)).toEqual({
      ids: [membersOwn.id, sharedWithMember.id, teamGateway.id, orgProfile.id],
      total: 4,
    });
    // The admin reads everything, but the default Show selection keeps only
    // what is theirs, shared with them or with the organization: not the
    // gateways of a team they are not in, nor others' personal ones.
    expect(await listed(admin)).toEqual({ ids: [orgProfile.id], total: 1 });
    expect((await listed(admin)).ids).not.toContain(othersPersonal.id);
  });

  test("pins are listed newest pin first and leave the table", async ({
    makeAgent,
  }) => {
    const gateways = [];
    for (let index = 0; index < 3; index++)
      gateways.push(
        await makeAgent({
          organizationId,
          agentType: "mcp_gateway",
          access: "org",
        }),
      );
    for (const [index, gateway] of gateways.entries())
      await createdOn(gateway.id, new Date(Date.UTC(2026, 0, index + 1)));
    caller = member;
    for (const gateway of [gateways[0], gateways[2]]) {
      const pin = await app.inject({
        method: "PUT",
        url: `/api/agents/${gateway.id}/pin`,
      });
      expect(pin.statusCode, pin.body).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const ids = async (url: string) =>
      (await app.inject({ method: "GET", url }))
        .json()
        .data.map((agent: { id: string }) => agent.id);
    expect(await ids(pageUrls().pinned)).toEqual([
      gateways[2].id,
      gateways[0].id,
    ]);
    expect(await ids(pageUrls().table)).toEqual([gateways[1].id]);
  });
});

/** Gives an agent a known creation time, which orders the table. */
async function createdOn(agentId: string, createdAt: Date) {
  await db
    .update(schema.agentsTable)
    .set({ createdAt })
    .where(eq(schema.agentsTable.id, agentId));
}

/** The gateways page's three requests, as the page sends them. */
function pageUrls() {
  const common =
    "sortBy=createdAt&sortDirection=desc&agentTypes=mcp_gateway,profile&access=mine,shared,org&includeTools=false";
  return {
    table: `/api/agents?limit=10&offset=0&${common}&pinned=false`,
    pinned: `/api/agents?limit=100&offset=0&${common}&pinned=true&includeTotal=false`,
    automaticPins: `/api/agents?limit=20&offset=0&agentTypes=mcp_gateway,profile&ids=${crypto.randomUUID()}&includeTools=false&includeTotal=false`,
  };
}
