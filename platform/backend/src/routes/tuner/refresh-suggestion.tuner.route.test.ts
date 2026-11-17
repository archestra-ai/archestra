import { randomUUID } from "node:crypto";
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import AuditLogModel from "@/models/audit-log";
import TunerSuggestionModel from "@/models/tuner-suggestion";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { type TunerSuggestedAction, tunerFingerprint } from "@/types/tuner";
import type { TunerSuggestion } from "@/types/tuner-suggestion";
import { drainBackgroundWork } from "@/utils/background-work";
import tunerRoutes from "./tuner.routes";

const POLICY_CHANGE: TunerSuggestedAction = {
  type: "policy_change",
  expectedRevision: 1,
  edits: [
    { oldText: "delta = {}\n", newText: "delta = { trust = 'trusted' }\n" },
  ],
  gate: {
    verification: "unverified",
    reasons: ["no_saved_validations"],
    files: [],
    suiteVersion: "empty",
  },
  publication: null,
};

describe("POST /api/tuner-suggestions/:id/refresh", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let adminId: string;
  let suggestion: TunerSuggestion;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    }) => {
      config.tuners.enabled = true;
      organizationId = (await makeOrganization()).id;
      adminId = (await makeUser()).id;
      await makeMember(adminId, organizationId, { role: ADMIN_ROLE_NAME });
      const trigger = await makeScheduleTrigger({
        organizationId,
        actorUserId: adminId,
        tunerKind: "appa",
      });
      const run = await makeScheduleTriggerRun(trigger.id);
      const proposed = await TunerSuggestionModel.propose({
        organizationId,
        tunerKind: "appa",
        candidate: {
          fingerprint: tunerFingerprint("appa_hitl_approvals", "mail__send"),
          source: "appa_hitl_approvals",
          severity: "info",
          title: "mail__send is always approved",
          detail: "40 approvals",
          evidence: [],
        },
        rationale: "Approvals are routine",
        action: POLICY_CHANGE,
        scheduleTriggerRunId: run.id,
        now: new Date(),
      });
      if (proposed.type !== "created") throw new Error("expected a suggestion");
      suggestion = proposed.suggestion;
      app = await authenticatedRouteApp({
        organizationId,
        routes: [tunerRoutes],
        auditLog: true,
      });
    },
  );

  afterEach(async () => {
    await app.close();
  });

  const refresh = (id: string, userId = adminId) =>
    app.inject({
      method: "POST",
      url: `/api/tuner-suggestions/${id}/refresh`,
      headers: { [USER_HEADER]: userId },
    });
  const stored = () =>
    TunerSuggestionModel.findById({ id: suggestion.id, organizationId });

  test("an open suggestion comes back unchanged, and the refresh is audited", async () => {
    const before = await stored();

    const response = await refresh(suggestion.id);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: suggestion.id,
      status: "open",
    });
    expect(await stored()).toEqual(before);

    await drainBackgroundWork();
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: suggestion.id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual([
      expect.objectContaining({
        action: "tunerSuggestion.refreshed",
        outcome: "success",
        resourceType: "tunerSuggestion",
        actorId: adminId,
      }),
    ]);
  });

  test("a claimed change that has no change request yet comes back unchanged", async () => {
    await TunerSuggestionModel.claimForApply({
      id: suggestion.id,
      organizationId,
      userId: adminId,
    });
    const before = await stored();

    const response = await refresh(suggestion.id);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "published" });
    expect(await stored()).toEqual(before);
  });

  test("an unknown suggestion is not found", async () => {
    expect((await refresh(randomUUID())).statusCode).toBe(404);
  });

  test("is not found while tuners are disabled", async () => {
    config.tuners.enabled = false;
    expect((await refresh(suggestion.id)).statusCode).toBe(404);
  });

  test("refuses members and roles missing tuner:update or log:admin", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const userWithRole = async (role: string) => {
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role });
      return user.id;
    };
    const customRole = async (permission: Record<string, string[]>) =>
      (await makeCustomRole(organizationId, { permission })).role;

    const denied = [
      await userWithRole(MEMBER_ROLE_NAME),
      await userWithRole(EDITOR_ROLE_NAME),
      await userWithRole(
        await customRole({ tuner: ["read"], log: ["read", "admin"] }),
      ),
      await userWithRole(await customRole({ tuner: ["read", "update"] })),
    ];
    for (const userId of denied) {
      expect((await refresh(suggestion.id, userId)).statusCode).toBe(403);
    }
  });
});
