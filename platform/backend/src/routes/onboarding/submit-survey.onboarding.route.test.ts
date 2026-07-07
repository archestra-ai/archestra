import { WEBSITE_URL } from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import { OrganizationModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const fetchMock = vi.fn();

const VALID_BODY = {
  role: "Software engineer",
  workEnvironment: "Startup (<50 people)",
  referralSource: "GitHub",
  workEmail: "someone@example.com",
};

describe("POST /api/onboarding/survey", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

    // Stubs auto-revert after every test, so re-apply per test.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: onboardingRoutes } = await import("./onboarding.routes");
    await app.register(onboardingRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("forwards the survey with the platform version and marks the organization", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/survey",
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      new URL("/api/onboarding-survey", WEBSITE_URL).toString(),
    );
    expect(JSON.parse(init.body)).toEqual({
      ...VALID_BODY,
      archestraVersion: config.api.version,
    });

    const organization = await OrganizationModel.getById(organizationId);
    expect(organization?.onboardingSurveyCompletedAt).not.toBeNull();
  });

  test("still succeeds and marks the organization when the website rejects", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/survey",
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const organization = await OrganizationModel.getById(organizationId);
    expect(organization?.onboardingSurveyCompletedAt).not.toBeNull();
  });

  test("still succeeds and marks the organization when the website is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/survey",
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const organization = await OrganizationModel.getById(organizationId);
    expect(organization?.onboardingSurveyCompletedAt).not.toBeNull();
  });

  test("short-circuits without forwarding when already submitted for the organization", async () => {
    await OrganizationModel.markOnboardingSurveyCompleted(organizationId);

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/survey",
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects a missing required field", async () => {
    const { role: _role, ...withoutRole } = VALID_BODY;
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/survey",
      payload: withoutRole,
    });
    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects a malformed work email", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/survey",
      payload: { ...VALID_BODY, workEmail: "not-an-email" },
    });
    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
