import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// 1x1 transparent PNG
const PNG_1PX_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// 1x1 GIF89a
const GIF_1PX_DATA_URI =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

describe("Onboarding wizard round-trip", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: organizationRoutes } = await import("./organization");
    await app.register(organizationRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("saves and reads back a two-page wizard", async () => {
    const wizard = {
      label: "E2E Setup",
      pages: [
        { image: PNG_1PX_DATA_URI, content: "# Step 1\n\nDo the first thing." },
        { image: GIF_1PX_DATA_URI, content: "## Step 2\n\nDo the second." },
      ],
    };

    const saveResponse = await app.inject({
      method: "PATCH",
      url: "/api/organization/appearance-settings",
      payload: { onboardingWizard: wizard },
    });
    expect(saveResponse.statusCode).toBe(200);
    const saved = saveResponse.json();
    expect(saved.onboardingWizard).toBeTruthy();
    expect(saved.onboardingWizard.label).toBe("E2E Setup");
    expect(saved.onboardingWizard.pages).toHaveLength(2);
    expect(saved.onboardingWizard.pages[0].image).toBe(PNG_1PX_DATA_URI);
    expect(saved.onboardingWizard.pages[1].image).toBe(GIF_1PX_DATA_URI);

    const getResponse = await app.inject({
      method: "GET",
      url: "/api/organization",
    });
    expect(getResponse.statusCode).toBe(200);
    const org = getResponse.json();
    expect(org.onboardingWizard).toBeTruthy();
    expect(org.onboardingWizard.pages[1].content).toContain("Step 2");
  });

  test("rejects a wizard with more than 10 pages", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/appearance-settings",
      payload: {
        onboardingWizard: {
          label: "Too many",
          pages: Array.from({ length: 11 }, () => ({ content: "x" })),
        },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  test("rejects a wizard with zero pages", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/appearance-settings",
      payload: {
        onboardingWizard: {
          label: "Empty",
          pages: [],
        },
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
