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
        hasArchive: false,
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
          url: `/api/chat/agents/${agent.id}/mcp-tools`,
          body: [],
        },
        {
          method: "get",
          url: "/api/members/default-model",
          body: { modelId: null, chatApiKeyId: null },
        },
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
      await expect(
        page.getByText(
          "Yells are agent reports of confusing blocks or remedies. Investigate them in chat and mark them resolved once fixed.",
        ),
      ).toBeVisible();
      const table = page.getByRole("table");
      await expect
        .poll(() =>
          table.evaluate((element) => {
            const container = element.parentElement;
            return container
              ? container.scrollWidth <= container.clientWidth + 1
              : false;
          }),
        )
        .toBe(true);
      const action = page.getByRole("button", { name: "Investigate in chat" });
      await expect(action).toBeInViewport({ ratio: 1 });
      await mswControl.registerMany([
        {
          method: "get",
          url: "/api/openappa/yells",
          body: {
            data: [
              {
                ...yell,
                resolvedAt: "2026-09-30T13:00:00Z",
                resolvedBy: "reviewer",
              },
            ],
            pagination,
          },
        },
      ]);
      await page
        .getByRole("button", { name: "Mark resolved", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Reopen", exact: true }),
      ).toBeVisible();
      await mswControl.registerMany([
        {
          method: "get",
          url: "/api/openappa/yells",
          body: { data: [yell], pagination },
        },
        { method: "patch", url: `/api/openappa/yells/${yell.id}`, body: yell },
      ]);
      await page.getByRole("button", { name: "Reopen", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Mark resolved", exact: true }),
      ).toBeVisible();
      await mswControl.registerMany([
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
      await mswControl.use({
        method: "get",
        url: "/api/openappa/yells",
        query: { search: "missing" },
        body: { data: [], pagination },
      });
      await page.getByPlaceholder("Search reports").fill("missing");
      await expect(
        page.getByText("No reports match these filters."),
      ).toBeVisible();
      await page.getByPlaceholder("Search reports").fill("");
      await page.getByRole("button", { name: yell.message }).click();
      const dialog = page.getByRole("dialog", { name: /OpenAPPA yell/ });
      await expect(dialog.getByText(yell.message)).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: /Mark resolved|Reopen/ }),
      ).toHaveCount(0);
      const chat = dialog.getByRole("button", { name: "Investigate in chat" });
      await expect(chat).toBeVisible();
      await expect(dialog).toBeInViewport();
      await chat.click();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === "/chat" &&
          url.searchParams.get("agentId") === agent.id &&
          (url.searchParams.get("user_prompt")?.includes(yell.id) ?? false) &&
          !(
            url.searchParams.get("user_prompt")?.includes(yell.message) ?? false
          ),
      );
    });
  });
}
