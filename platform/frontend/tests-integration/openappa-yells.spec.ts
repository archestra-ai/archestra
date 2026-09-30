import { makeAgent } from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";

for (const width of [1280, 390]) {
  test.describe(`OpenAPPA yells at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("searches reports, resolves one, and opens a configuration chat", async ({
      page,
      request,
      mswControl,
    }) => {
      const config = await (
        await request.get("/internal-test/api/api/config")
      ).json();
      const permissions = await (
        await request.get("/internal-test/api/api/user/permissions")
      ).json();
      const agent = makeAgent({
        id: "openappa-configuration-agent",
        scope: "org",
        builtIn: true,
        builtInAgentConfig: { name: "openappa-configuration-agent" },
        authorId: null,
      });
      const yell = {
        id: "11111111-1111-4111-8111-111111111111",
        organizationId: "org",
        callerId: "user:reporter",
        sessionId: "session",
        toolCallId: "call",
        message:
          "Reading the project notes was blocked after opening a public page.",
        withTrajectory: true,
        createdAt: "2026-09-30T12:00:00Z",
        reportedAt: "2026-09-30T12:00:01Z",
        reportFailed: false,
        resolvedAt: null,
        resolvedBy: null,
      };
      const pagination = { limit: 20, hasNext: false, nextCursor: null };
      await mswControl.registerMany([
        {
          method: "get",
          url: "/api/config",
          body: {
            ...config,
            features: { ...config.features, openappaEnabled: true },
          },
        },
        {
          method: "get",
          url: "/api/user/permissions",
          body: {
            ...permissions,
            log: ["read"],
            toolPolicy: ["read", "update"],
          },
        },
        {
          method: "get",
          url: "/api/guardrails-policy",
          body: {
            organizationId: "org",
            revision: 1,
            content: "[policy]\nversion = 2\n",
            contentHash: "hash",
            updatedAt: null,
            updatedBy: null,
          },
        },
        {
          method: "get",
          url: "/api/guardrails-deployment",
          body: { enabled: true, featureEnabled: true, active: true },
        },
        { method: "get", url: "/api/agents/all", body: [agent] },
        {
          method: "get",
          url: "/api/openappa/yells",
          body: { data: [yell], pagination },
        },
        {
          method: "get",
          url: "/api/openappa/yells",
          query: { search: "missing" },
          body: { data: [], pagination },
        },
        {
          method: "patch",
          url: `/api/openappa/yells/${yell.id}`,
          body: {
            ...yell,
            resolvedAt: "2026-09-30T13:00:00Z",
            resolvedBy: "reviewer",
          },
        },
      ]);
      await page.goto("/openappa/yells");
      await expect(
        page.getByRole("button", { name: yell.message }),
      ).toBeVisible();
      await page.getByPlaceholder("Search reports").fill("missing");
      await expect(
        page.getByText("No reports match these filters."),
      ).toBeVisible();
      await page.getByPlaceholder("Search reports").fill("");
      await page.getByRole("button", { name: yell.message }).click();
      const dialog = page.getByRole("dialog", { name: "OpenAPPA yell" });
      await expect(dialog.getByText(yell.message)).toBeVisible();
      await dialog.getByRole("button", { name: "Mark resolved" }).click();
      await expect(
        dialog.getByRole("button", { name: "Reopen" }),
      ).toBeVisible();
      const chat = dialog.getByRole("link", { name: "Investigate in chat" });
      const href = await chat.getAttribute("href");
      expect(href).toContain("openappa-configuration-agent");
      expect(decodeURIComponent(href ?? "")).toContain(yell.id);
      expect(decodeURIComponent(href ?? "")).not.toContain(yell.message);
      await expect(chat).toBeVisible();
      await expect(dialog).toBeInViewport();
    });
  });
}
