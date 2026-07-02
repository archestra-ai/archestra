import config from "@/config";
import { OnboardingSurveySubmissionModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import type { User } from "@/types";

describe("GET/POST /api/onboarding/survey", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async ({ makeOrganization, makeAdmin }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();

    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: onboardingRoutes } = await import("./onboarding.routes");
    await app.register(onboardingRoutes);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  test("needs submission on a fresh empty org, then not after submitting", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/onboarding/survey/status",
    });
    expect(before.json()).toEqual({ needsSubmission: true });

    const submit = await app.inject({
      method: "POST",
      url: "/api/onboarding/survey",
      payload: {
        role: "Software engineer",
        workEnvironment: "Studying / between things",
        referralSource: "GitHub",
        workEmail: "dev@example.com",
      },
    });
    expect(submit.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/onboarding/survey/status",
    });
    expect(after.json()).toEqual({ needsSubmission: false });

    expect(
      await OnboardingSurveySubmissionModel.hasSubmitted(organizationId),
    ).toBe(true);
  });

  test("forwards the answers and archestra version to the website", async () => {
    await app.inject({
      method: "POST",
      url: "/api/onboarding/survey",
      payload: {
        role: "SRE",
        workEnvironment: "Ops",
        referralSource: "Reddit",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toMatchObject({
      role: "SRE",
      referralSource: "Reddit",
      archestraVersion: config.api.version,
    });
  });

  test("still records the marker when forwarding fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/survey",
      payload: {
        role: "AI Team",
        workEnvironment: "Research",
        referralSource: "YouTube",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(
      await OnboardingSurveySubmissionModel.hasSubmitted(organizationId),
    ).toBe(true);
  });

  test("does not need submission on a licensed enterprise deployment", async () => {
    const original = config.enterpriseFeatures.core;
    config.enterpriseFeatures.core = true;
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/onboarding/survey/status",
      });
      expect(res.json()).toEqual({ needsSubmission: false });
    } finally {
      config.enterpriseFeatures.core = original;
    }
  });

  test("rejects an invalid work email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/survey",
      payload: {
        role: "Software engineer",
        workEnvironment: "Home",
        referralSource: "Conference",
        workEmail: "not-an-email",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
