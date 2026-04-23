import { expect, test } from "./api-fixtures";

// 1x1 transparent PNG
const PNG_1PX_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// 1x1 GIF89a
const GIF_1PX_DATA_URI =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

test.describe("Onboarding wizard round-trip", () => {
  test("saves and reads back a two-page wizard", async ({
    request,
    makeApiRequest,
  }) => {
    const wizard = {
      label: "E2E Setup",
      pages: [
        { image: PNG_1PX_DATA_URI, content: "# Step 1\n\nDo the first thing." },
        { image: GIF_1PX_DATA_URI, content: "## Step 2\n\nDo the second." },
      ],
    };

    try {
      const saveResponse = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/organization/appearance-settings",
        data: { onboardingWizard: wizard },
      });
      const saved = await saveResponse.json();
      expect(saved.onboardingWizard).toBeTruthy();
      expect(saved.onboardingWizard.label).toBe("E2E Setup");
      expect(saved.onboardingWizard.pages).toHaveLength(2);
      expect(saved.onboardingWizard.pages[0].image).toBe(PNG_1PX_DATA_URI);
      expect(saved.onboardingWizard.pages[1].image).toBe(GIF_1PX_DATA_URI);

      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/organization",
      });
      const org = await getResponse.json();
      expect(org.onboardingWizard).toBeTruthy();
      expect(org.onboardingWizard.pages[1].content).toContain("Step 2");
    } finally {
      await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/organization/appearance-settings",
        data: { onboardingWizard: null },
      });
    }
  });

  test("rejects a wizard with more than 10 pages", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: {
        onboardingWizard: {
          label: "Too many",
          pages: Array.from({ length: 11 }, () => ({ content: "x" })),
        },
      },
      ignoreStatusCheck: true,
    });
    expect(response.status()).toBe(400);
  });

  test("rejects a wizard with zero pages", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: {
        onboardingWizard: {
          label: "Empty",
          pages: [],
        },
      },
      ignoreStatusCheck: true,
    });
    expect(response.status()).toBe(400);
  });
});
