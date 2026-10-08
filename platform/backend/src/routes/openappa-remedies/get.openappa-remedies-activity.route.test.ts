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
  const consult = (params: {
    role: "authority" | "sanitizer" | "annotator";
    createdAt: Date;
    outcome?: "answered" | "timeout";
    answer?: Record<string, unknown> | null;
    organizationId?: string;
  }) => ({
    id: randomUUID(),
    organizationId: params.organizationId ?? ctx.organizationId,
    createdAt: params.createdAt,
    startedAt: params.createdAt,
    durationMs: 1,
    role: params.role,
    externalName: params.role,
    backend: "hitl" as const,
    request: {},
    outcome: params.outcome ?? ("answered" as const),
    answer: params.answer === undefined ? { ruling: "approve" } : params.answer,
    root: "root",
    trajectory: "root",
    offerId: "offer-1",
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

  test("returns seven empty days, oldest first, when nothing was answered", async () => {
    const body = await activity();
    expect(body.timeZone).toBe("UTC");
    expect(body.days).toHaveLength(7);
    expect(body.days.at(-1)?.date).toBe(utcDate(new Date()));
    expect(body.days.at(0)?.date).toBe(utcDate(daysAgo(6, 0)));
    expect(
      body.days.every(
        (day) => day.approved === 0 && day.denied === 0 && day.cleaned === 0,
      ),
    ).toBe(true);
  });

  test("counts per day what authorities and sanitizers answered", async ({
    makeOrganization,
  }) => {
    const otherOrganizationId = (await makeOrganization()).id;
    const today = daysAgo(0, 1);
    const twoDaysAgo = daysAgo(2);
    await db.insert(schema.openappaExternalConsultsTable).values([
      // Two reviews approved and one denied two days ago.
      consult({ role: "authority", createdAt: twoDaysAgo }),
      consult({ role: "authority", createdAt: twoDaysAgo }),
      consult({
        role: "authority",
        createdAt: twoDaysAgo,
        answer: { ruling: "deny" },
      }),
      // One result cleaned today; a sanitizer's answer carries no ruling.
      consult({ role: "sanitizer", createdAt: today, answer: null }),
      // Not counted: a review nobody answered, an annotator's consult, an
      // old consult and another organization's.
      consult({
        role: "authority",
        createdAt: today,
        outcome: "timeout",
        answer: null,
      }),
      consult({ role: "annotator", createdAt: today, answer: null }),
      consult({ role: "authority", createdAt: daysAgo(9) }),
      consult({
        role: "sanitizer",
        createdAt: today,
        answer: null,
        organizationId: otherOrganizationId,
      }),
    ]);

    const body = await activity();
    const byDate = Object.fromEntries(
      body.days.map((day) => [
        day.date,
        [day.approved, day.denied, day.cleaned],
      ]),
    );
    expect(byDate[utcDate(twoDaysAgo)]).toEqual([2, 1, 0]);
    expect(byDate[utcDate(today)]).toEqual([0, 0, 1]);
    expect(
      body.days.reduce(
        (total, day) => total + day.approved + day.denied + day.cleaned,
        0,
      ),
    ).toBe(4);
  });
});
