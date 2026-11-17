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
import { tunerFingerprint } from "@/types/tuner";
import type { TunerSuggestion } from "@/types/tuner-suggestion";
import { drainBackgroundWork } from "@/utils/background-work";
import tunerRoutes from "./tuner.routes";

describe("POST /api/tuner-suggestions/:id/done", () => {
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
        tunerKind: "sre",
      });
      const run = await makeScheduleTriggerRun(trigger.id);
      suggestion = await proposeNote(organizationId, run.id);
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

  const done = (
    id: string,
    payload: { comment?: string | null } = {},
    userId = adminId,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/tuner-suggestions/${id}/done`,
      headers: { [USER_HEADER]: userId },
      payload,
    });
  const stored = async () =>
    (await TunerSuggestionModel.findById({ id: suggestion.id, organizationId }))
      ?.status;

  test("closes an open suggestion as done by the caller and audits it", async () => {
    const response = await done(suggestion.id, { comment: "Raised the limit" });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      await TunerSuggestionModel.findById({
        id: suggestion.id,
        organizationId,
      }),
    ).toMatchObject({
      status: "done",
      statusChangedBy: adminId,
      comment: "Raised the limit",
    });

    await drainBackgroundWork();
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: suggestion.id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual([
      expect.objectContaining({
        action: "tunerSuggestion.done",
        outcome: "success",
        resourceType: "tunerSuggestion",
        actorId: adminId,
        before: expect.objectContaining({ status: "open" }),
        after: expect.objectContaining({ status: "done" }),
      }),
    ]);
  });

  test("a comment is optional", async () => {
    const response = await done(suggestion.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "done", comment: null });
  });

  test("a suggestion that is no longer open conflicts", async () => {
    expect((await done(suggestion.id)).statusCode).toBe(200);
    expect((await done(suggestion.id)).statusCode).toBe(409);
  });

  test("another organization's suggestion is not found and stays open", async ({
    makeOrganization,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const otherOrganizationId = (await makeOrganization()).id;
    const trigger = await makeScheduleTrigger({
      organizationId: otherOrganizationId,
      tunerKind: "sre",
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    const other = await proposeNote(otherOrganizationId, run.id);

    expect((await done(other.id)).statusCode).toBe(404);
    expect(
      (
        await TunerSuggestionModel.findById({
          id: other.id,
          organizationId: otherOrganizationId,
        })
      )?.status,
    ).toBe("open");
  });

  test("is not found while tuners are disabled", async () => {
    config.tuners.enabled = false;
    expect((await done(suggestion.id)).statusCode).toBe(404);
    expect(await stored()).toBe("open");
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
      expect((await done(suggestion.id, {}, userId)).statusCode).toBe(403);
    }
    expect(await stored()).toBe("open");
  });
});

async function proposeNote(
  organizationId: string,
  scheduleTriggerRunId: string,
): Promise<TunerSuggestion> {
  const proposed = await TunerSuggestionModel.propose({
    organizationId,
    tunerKind: "sre",
    candidate: {
      fingerprint: tunerFingerprint("sre_pod_stuck", "default", "api"),
      source: "sre_pod_stuck",
      severity: "warn",
      title: "api is stuck",
      detail: "Pending for an hour",
      evidence: [],
    },
    rationale: "why",
    action: { type: "note" },
    scheduleTriggerRunId,
    now: new Date(),
  });
  if (proposed.type !== "created") throw new Error("expected a suggestion");
  return proposed.suggestion;
}
