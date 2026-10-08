import { randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import type { RemediesActivity } from "@/types/openappa-remedies";
import routes from "./openappa-remedies.routes";

describe("GET /api/openappa/remedies/activity", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
  });

  const activity = async (query = "?timeZone=UTC") => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/remedies/activity${query}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as RemediesActivity;
  };
  const daysAgo = (days: number, hours = 12) =>
    new Date(Date.now() - days * 24 * 3600_000 - hours * 3600_000);
  const utcDate = (at: Date) => at.toISOString().slice(0, 10);
  const operation = (params: {
    callId: string;
    createdAt: Date;
    decision: Record<string, unknown>;
    event?: string;
    organizationId?: string;
  }) => ({
    organizationId: params.organizationId ?? ctx.organizationId,
    sessionId: "session-1",
    operationId: `call:${params.callId}`,
    root: "root",
    status: "complete",
    input: { semantic: { event: params.event ?? "tool_call" } },
    decision: params.decision,
    createdAt: params.createdAt,
  });
  const consult = (params: {
    offerId: string;
    role: "authority" | "sanitizer";
    createdAt: Date;
    outcome?: "answered" | "timeout";
    answer?: Record<string, unknown> | null;
  }) => ({
    id: randomUUID(),
    organizationId: ctx.organizationId,
    createdAt: params.createdAt,
    startedAt: params.createdAt,
    durationMs: 1,
    role: params.role,
    externalName: params.role === "authority" ? "human" : "redact-secrets",
    backend: "hitl" as const,
    request: {},
    outcome: params.outcome ?? ("answered" as const),
    answer: params.answer === undefined ? { ruling: "approve" } : params.answer,
    root: "root",
    trajectory: "root",
    offerId: params.offerId,
  });

  test("is not found while Guardrails v2 is disabled", async () => {
    config.openappa.enabled = false;
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/remedies/activity",
    });
    expect(response.statusCode).toBe(404);
  });

  test("rejects a time zone Postgres would not know", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/remedies/activity?timeZone=Mars/Olympus",
    });
    expect(response.statusCode).toBe(400);
  });

  test("returns seven empty days, oldest first, when nothing was denied", async () => {
    const body = await activity();
    expect(body.timeZone).toBe("UTC");
    expect(body.days).toHaveLength(7);
    expect(body.days.at(-1)?.date).toBe(utcDate(new Date()));
    expect(body.days.at(0)?.date).toBe(utcDate(daysAgo(6, 0)));
    expect(
      body.days.every((day) => day.blocked === 0 && day.remedied === 0),
    ).toBe(true);
  });

  test("counts denied tool calls per day and the ones a remedy let through", async ({
    makeOrganization,
  }) => {
    const otherOrganizationId = (await makeOrganization()).id;
    const today = daysAgo(0, 1);
    const twoDaysAgo = daysAgo(2);
    await db.insert(schema.openappaOperationsTable).values([
      // Approved by a person: got through.
      operation({
        callId: "a",
        createdAt: twoDaysAgo,
        decision: {
          decision: "deny_call",
          feedback: "blocked",
          offers: [{ offer_id: "offer-a" }],
        },
      }),
      // The person said no: stayed blocked.
      operation({
        callId: "b",
        createdAt: twoDaysAgo,
        decision: {
          decision: "deny_call",
          feedback: "blocked",
          offers: [{ offer_id: "offer-b" }],
        },
      }),
      // No offer at all: stayed blocked.
      operation({
        callId: "c",
        createdAt: twoDaysAgo,
        decision: { decision: "deny_call", feedback: "blocked" },
      }),
      // Cleaned by a sanitizer: got through. Two offers, one answered, counts once.
      operation({
        callId: "d",
        createdAt: today,
        decision: {
          decision: "deny_call",
          feedback: "blocked",
          offers: [{ offer_id: "offer-d1" }, { offer_id: "offer-d2" }],
        },
      }),
      // The authority never answered: stayed blocked.
      operation({
        callId: "e",
        createdAt: today,
        decision: {
          decision: "deny_call",
          feedback: "blocked",
          offers: [{ offer_id: "offer-e" }],
        },
      }),
      // Allowed calls, results and old denials are not blocked calls of the window.
      operation({
        callId: "f",
        createdAt: today,
        decision: { decision: "allow_call" },
      }),
      operation({
        callId: "g",
        createdAt: today,
        event: "tool_result",
        decision: { decision: "block" },
      }),
      operation({
        callId: "h",
        createdAt: daysAgo(9),
        decision: { decision: "deny_call", feedback: "blocked" },
      }),
      // Another organization's denial.
      operation({
        callId: "i",
        createdAt: today,
        organizationId: otherOrganizationId,
        decision: { decision: "deny_call", feedback: "blocked" },
      }),
    ]);
    await db.insert(schema.openappaExternalConsultsTable).values([
      consult({ offerId: "offer-a", role: "authority", createdAt: twoDaysAgo }),
      consult({
        offerId: "offer-b",
        role: "authority",
        createdAt: twoDaysAgo,
        answer: { ruling: "deny" },
      }),
      consult({
        offerId: "offer-d1",
        role: "sanitizer",
        createdAt: today,
        answer: null,
      }),
      consult({
        offerId: "offer-e",
        role: "authority",
        createdAt: today,
        outcome: "timeout",
        answer: null,
      }),
    ]);

    const body = await activity();
    const byDate = Object.fromEntries(
      body.days.map((day) => [day.date, [day.blocked, day.remedied]]),
    );
    expect(byDate[utcDate(twoDaysAgo)]).toEqual([3, 1]);
    expect(byDate[utcDate(today)]).toEqual([2, 1]);
    expect(body.days.reduce((total, day) => total + day.blocked, 0)).toBe(5);
  });
});
