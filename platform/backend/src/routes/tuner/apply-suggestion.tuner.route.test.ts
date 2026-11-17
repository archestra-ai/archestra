import { createHash } from "node:crypto";
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import AuditLogModel from "@/models/audit-log";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
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

const POLICY = `[policy]
version = 2
[[policy.tool]]
name = 'files__read'
delta = { trust = 'suspicious' }
[[policy.tool]]
name = 'mail__send'
delta = {}
requires = { trust = 'trusted' }
`;
const ADD_RULE = {
  oldText: "[[policy.tool]]\nname = 'mail__send'\n",
  newText:
    "[[policy.tool]]\nname = 'notes__read'\ndelta = {}\n[[policy.tool]]\nname = 'mail__send'\n",
};

describe("POST /api/tuner-suggestions/:id/apply", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let adminId: string;
  let propose: (action: TunerSuggestedAction) => Promise<TunerSuggestion>;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    }) => {
      config.tuners.enabled = true;
      config.openappa.enabled = true;
      organizationId = (await makeOrganization()).id;
      adminId = (await makeUser()).id;
      await makeMember(adminId, organizationId, { role: ADMIN_ROLE_NAME });
      await GuardrailsPolicyModel.save({
        organizationId,
        content: POLICY,
        contentHash: createHash("sha256").update(POLICY).digest("hex"),
        updatedBy: adminId,
        expectedRevision: 0,
      });
      const trigger = await makeScheduleTrigger({
        organizationId,
        actorUserId: adminId,
        tunerKind: "appa",
      });
      const run = await makeScheduleTriggerRun(trigger.id);
      propose = async (action) => {
        const proposed = await TunerSuggestionModel.propose({
          organizationId,
          tunerKind: "appa",
          candidate: {
            fingerprint: tunerFingerprint(
              "appa_repeated_denials",
              "notes__read",
            ),
            source: "appa_repeated_denials",
            severity: "warn",
            title: "notes__read is denied repeatedly",
            detail: "12 denials",
            evidence: [],
          },
          rationale: "Reading notes is harmless",
          action,
          scheduleTriggerRunId: run.id,
          now: new Date(),
        });
        if (proposed.type !== "created")
          throw new Error("expected a suggestion");
        return proposed.suggestion;
      };
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

  const policyChange = (expectedRevision = 1): TunerSuggestedAction => ({
    type: "policy_change",
    expectedRevision,
    edits: [ADD_RULE],
    gate: {
      verification: "unverified",
      reasons: ["no_saved_validations"],
      files: [],
      suiteVersion: "empty",
    },
    publication: null,
  });
  const apply = (id: string, userId = adminId) =>
    app.inject({
      method: "POST",
      url: `/api/tuner-suggestions/${id}/apply`,
      headers: { [USER_HEADER]: userId },
    });
  const statusOf = async (id: string) =>
    (await TunerSuggestionModel.findById({ id, organizationId }))?.status;
  const latestPolicy = () => GuardrailsPolicyModel.findLatest(organizationId);

  test("saves the edited policy as a new revision by the caller, makes the suggestion effective, and audits it", async () => {
    const suggestion = await propose(policyChange());

    const response = await apply(suggestion.id);

    expect(response.statusCode, response.body).toBe(200);
    expect(await latestPolicy()).toMatchObject({
      revision: 2,
      content: POLICY.replace(ADD_RULE.oldText, ADD_RULE.newText),
      updatedBy: adminId,
    });
    expect(
      await TunerSuggestionModel.findById({
        id: suggestion.id,
        organizationId,
      }),
    ).toMatchObject({ status: "effective", statusChangedBy: adminId });

    await drainBackgroundWork();
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: suggestion.id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual([
      expect.objectContaining({
        action: "tunerSuggestion.applied",
        outcome: "success",
        resourceType: "tunerSuggestion",
        actorId: adminId,
        before: expect.objectContaining({ status: "open" }),
        after: expect.objectContaining({ status: "effective" }),
      }),
    ]);
  });

  test("a second apply conflicts and saves nothing more", async () => {
    const suggestion = await propose(policyChange());
    expect((await apply(suggestion.id)).statusCode).toBe(200);

    expect((await apply(suggestion.id)).statusCode).toBe(409);
    expect((await latestPolicy())?.revision).toBe(2);
    expect(await statusOf(suggestion.id)).toBe("effective");
  });

  test("a policy that changed since the suggestion conflicts and returns it to open", async () => {
    const suggestion = await propose(policyChange(0));

    expect((await apply(suggestion.id)).statusCode).toBe(409);
    expect(await statusOf(suggestion.id)).toBe("open");
    expect((await latestPolicy())?.revision).toBe(1);
  });

  test("a note cannot be applied", async () => {
    const suggestion = await propose({ type: "note" });

    expect((await apply(suggestion.id)).statusCode).toBe(400);
    expect(await statusOf(suggestion.id)).toBe("open");
  });

  test("a tuner manager without guardrailsPolicy:update is refused and the suggestion stays open", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const suggestion = await propose(policyChange());
    const manager = (await makeUser()).id;
    const role = await makeCustomRole(organizationId, {
      permission: { tuner: ["read", "update"], log: ["read", "admin"] },
    });
    await makeMember(manager, organizationId, { role: role.role });

    expect((await apply(suggestion.id, manager)).statusCode).toBe(403);
    expect(await statusOf(suggestion.id)).toBe("open");
    expect((await latestPolicy())?.revision).toBe(1);
  });

  test("another organization's suggestion is not found", async ({
    makeOrganization,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const otherOrganizationId = (await makeOrganization()).id;
    const trigger = await makeScheduleTrigger({
      organizationId: otherOrganizationId,
      tunerKind: "appa",
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    const proposed = await TunerSuggestionModel.propose({
      organizationId: otherOrganizationId,
      tunerKind: "appa",
      candidate: {
        fingerprint: tunerFingerprint("appa_repeated_denials", "notes__read"),
        source: "appa_repeated_denials",
        severity: "warn",
        title: "notes__read is denied repeatedly",
        detail: "12 denials",
        evidence: [],
      },
      rationale: "Reading notes is harmless",
      action: policyChange(),
      scheduleTriggerRunId: run.id,
      now: new Date(),
    });
    if (proposed.type !== "created") throw new Error("expected a suggestion");

    expect((await apply(proposed.suggestion.id)).statusCode).toBe(404);
    expect((await latestPolicy())?.revision).toBe(1);
  });

  test("is not found while tuners are disabled", async () => {
    const suggestion = await propose(policyChange());
    config.tuners.enabled = false;

    expect((await apply(suggestion.id)).statusCode).toBe(404);
    expect(await statusOf(suggestion.id)).toBe("open");
  });

  test("refuses members and roles missing tuner:update or log:admin", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const suggestion = await propose(policyChange());
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
        await customRole({
          tuner: ["read"],
          log: ["read", "admin"],
          guardrailsPolicy: ["read", "update"],
        }),
      ),
      await userWithRole(
        await customRole({
          tuner: ["read", "update"],
          guardrailsPolicy: ["read", "update"],
        }),
      ),
    ];
    for (const userId of denied) {
      expect((await apply(suggestion.id, userId)).statusCode).toBe(403);
    }
    expect(await statusOf(suggestion.id)).toBe("open");
    expect((await latestPolicy())?.revision).toBe(1);
  });
});
