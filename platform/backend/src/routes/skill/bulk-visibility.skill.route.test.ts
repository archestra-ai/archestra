import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { SkillModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import skillRoutes from "./skill.routes";
import { manifestNamed } from "./skill.test-helpers";

describe("POST /api/skills/bulk-visibility", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(skillRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const createSkill = async (name: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: manifestNamed(name) },
      })
    ).json();

  const bulkVisibility = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/skills/bulk-visibility",
      payload,
    });

  for (const scope of ["personal", "team", "org"] as const) {
    test(`rejects retired ${scope} sharing for every selected skill without changing grants`, async ({
      makeTeam,
      makeUser,
    }) => {
      const team = await makeTeam(organizationId, user.id);
      const recipient = await makeUser();
      const first = await createSkill("retired-sharing-a");
      const second = await createSkill("retired-sharing-b");
      const keys = [first.id, second.id].map((id) => ({
        organizationId,
        resource: "skill" as const,
        scope: id,
      }));
      const before = await Promise.all(
        keys.map((key) => ResourcePermissionPolicyModel.find(key)),
      );
      const response = await bulkVisibility({
        skillIds: [first.id, second.id],
        scope,
        teamIds: scope === "team" ? [team.id] : [],
        userIds: scope === "personal" ? [recipient.id] : [],
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().succeeded).toEqual([]);
      expect(response.json().failed).toHaveLength(2);
      for (const failure of response.json().failed)
        expect(failure.error).toContain("resource permissions API");
      expect(
        await Promise.all(
          keys.map((key) => ResourcePermissionPolicyModel.find(key)),
        ),
      ).toEqual(before);
      expect((await SkillModel.findById(first.id))?.scope).toBe("personal");
      expect((await SkillModel.findById(second.id))?.scope).toBe("personal");
    });
  }

  test("rejects an empty selection", async () => {
    const response = await bulkVisibility({ skillIds: [], scope: "org" });
    expect(response.statusCode).toBe(400);
  });
});
