import { makeAgent } from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";

for (const width of [1280, 390]) {
  for (const serviceAccount of [false, true]) {
    test.describe(`OpenAPPA yells at ${width}px from ${serviceAccount ? "service account" : "user"}`, () => {
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
          callerId: serviceAccount
            ? "user:service-account:reporter"
            : "user:reporter",
          caller: serviceAccount
            ? {
                id: "service-account:reporter",
                name: "Report automation",
                email: null,
                type: "service_account",
              }
            : {
                id: "reporter",
                name: "Alex Reporter",
                email: "alex@example.com",
              },
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
          conversation: null,
        };
        const resolvedYell = {
          ...yell,
          resolvedAt: "2026-09-30T13:00:00Z",
          resolvedBy: "reviewer",
        };
        const pagination = { limit: 20, hasNext: false, nextCursor: null };
        const eventsUrl = "/api/openappa/guardrail-events";
        const events = (...yells: object[]) => ({
          data: yells.map((item) => ({ type: "yell", yell: item })),
          pagination,
        });
        const listRequest = (status: string | null) =>
          page.waitForRequest(
            (request) =>
              new URL(request.url()).pathname === eventsUrl &&
              new URL(request.url()).searchParams.get("yellStatus") === status,
          );
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
              guardrailsPolicy: ["read", "update"],
              organizationSettings: ["read", "update"],
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
          { method: "get", url: "/api/agents/chat-roster", body: [agent] },
          { method: "get", url: `/api/agents/${agent.id}`, body: agent },
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
          { method: "get", url: eventsUrl, body: events(yell) },
          {
            method: "get",
            url: eventsUrl,
            query: { yellStatus: "resolved" },
            body: events(),
          },
          {
            method: "get",
            url: `/api/openappa/yells/${yell.id}`,
            body: yell,
          },
          {
            method: "patch",
            url: `/api/openappa/yells/${yell.id}`,
            body: resolvedYell,
          },
        ]);
        const initialList = listRequest(null);
        await page.goto("/consults/logs?type=yell");
        expect(
          new URL((await initialList).url()).searchParams.get("type"),
        ).toBe("yell");
        const report = page.getByText(yell.message, { exact: true });
        await expect(report).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Guardrails", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        const table = page.getByRole("table");
        await expect(
          table.getByText(
            serviceAccount ? "Report automation" : "Alex Reporter",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          table.getByText("Unresolved", { exact: true }),
        ).toBeVisible();
        if (width === 1280) {
          await expect(
            page.getByRole("combobox", { name: "Record type" }),
          ).toHaveText("Yells");
          // An outcome belongs to consults, which this view leaves out.
          await expect(
            page.getByRole("button", { name: "Export consults" }),
          ).toBeDisabled();
          const status = page.getByRole("combobox", { name: "Yell status" });
          await expect(status).toHaveText("All yell statuses");
          await status.click();
          const resolvedList = listRequest("resolved");
          await page
            .getByRole("option", { name: "Resolved yells", exact: true })
            .click();
          await resolvedList;
          await expect(page).toHaveURL(/yellStatus=resolved/);
          await expect(
            page.getByText("Nothing matches your filters"),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Clear", exact: true })
            .click();
          await expect(page).toHaveURL(/\/consults\/logs$/);
          await expect(report).toBeVisible();
        }
        await mswControl.use({
          method: "get",
          url: eventsUrl,
          body: events(resolvedYell),
        });
        await page
          .getByRole("button", { name: "Mark resolved", exact: true })
          .click();
        await expect(page.getByText("Yell marked resolved")).toBeVisible();
        await expect(
          table.getByText("Resolved", { exact: true }),
        ).toBeVisible();
        await mswControl.registerMany([
          { method: "get", url: eventsUrl, body: events(yell) },
          {
            method: "patch",
            url: `/api/openappa/yells/${yell.id}`,
            body: yell,
          },
        ]);
        await page.getByRole("button", { name: "Reopen", exact: true }).click();
        await expect(page.getByText("Yell reopened")).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Mark resolved", exact: true }),
        ).toBeVisible();
        // A report opens on its own page under the log.
        await report.click();
        await expect(page).toHaveURL(
          new RegExp(`/consults/logs/yells/${yell.id}$`),
        );
        await expect(
          page.getByRole("link", { name: "Back to Guardrails logs" }),
        ).toHaveAttribute("href", "/consults/logs?type=yell");
        await expect(
          page.getByText(yell.message, { exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Investigate in chat", exact: true })
          .click();
        await expect(page).toHaveURL(
          (url) =>
            url.pathname === "/chat" &&
            url.searchParams.get("agentId") === agent.id &&
            (url.searchParams.get("user_prompt")?.includes(yell.id) ?? false) &&
            !(
              url.searchParams.get("user_prompt")?.includes(yell.message) ??
              false
            ),
        );
      });
    });
  }
}

test("a log-only reader reaches yells in the log without fetching policy or settings", async ({
  page,
  request,
  mswControl,
}, testInfo) => {
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  const permissions = await (
    await request.get("/internal-test/api/api/user/permissions")
  ).json();
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
        chat: ["read"],
        guardrailsPolicy: [],
        organizationSettings: [],
        log: ["read"],
      },
    },
    {
      method: "get",
      url: "/api/openappa/guardrail-events",
      body: {
        data: [
          {
            type: "yell",
            yell: {
              id: "diagnostic-report",
              organizationId: "org",
              callerId: "user:reporter",
              caller: null,
              sessionId: "session",
              toolCallId: "call",
              message: "Reading project notes was blocked.",
              withTrajectory: true,
              hasArchive: true,
              createdAt: "2026-10-01T12:00:00Z",
              reportedAt: null,
              reportFailed: false,
              resolvedAt: null,
              resolvedBy: null,
              conversation: null,
            },
          },
        ],
        pagination: { limit: 20, hasNext: false, nextCursor: null },
      },
    },
    ...[
      "/api/guardrails-policy",
      "/api/guardrails-deployment",
      "/api/openappa/github-sync",
    ].map((url) => ({
      method: "get" as const,
      url,
      status: 403,
      body: { error: { message: "Forbidden" } },
    })),
  ]);
  const forbiddenRequests: string[] = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (
      [
        "/api/guardrails-policy",
        "/api/guardrails-deployment",
        "/api/openappa/github-sync",
      ].includes(path)
    )
      forbiddenRequests.push(path);
  });
  await page.goto("/consults/logs?type=yell");
  await expect(
    page.getByText("Reading project notes was blocked.", { exact: true }),
  ).toBeVisible();
  expect(forbiddenRequests).toEqual([]);
  const investigate = page.getByRole("button", { name: "Investigate in chat" });
  await expect(investigate).toHaveAttribute("aria-disabled", "true");
  await investigate.click({ force: true });
  await expect(page).toHaveURL(/\/consults\/logs\?type=yell$/);
  await investigate.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Missing permissions");
  await expect(tooltip).toContainText("Chats: create");
  await expect(tooltip).toContainText("Guardrails Policy: read");
  await expect(tooltip).not.toContainText("Diagnostics");
  // What the yell left behind is folded into the row's menu.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /more/i }).click();
  await expect(
    page.getByRole("menuitem", { name: "Download report" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("yells-permissions.png") });
});
