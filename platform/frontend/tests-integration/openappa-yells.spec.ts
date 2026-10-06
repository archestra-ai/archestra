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
        };
        const resolvedYell = {
          ...yell,
          resolvedAt: "2026-09-30T13:00:00Z",
          resolvedBy: "reviewer",
        };
        const pagination = { limit: 20, hasNext: false, nextCursor: null };
        const listRequest = (status: string) =>
          page.waitForRequest(
            (request) =>
              new URL(request.url()).pathname === "/api/openappa/yells" &&
              new URL(request.url()).searchParams.get("status") === status,
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
              openappaDiagnostics: ["read", "update"],
              openappaPolicy: ["read", "update"],
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
            query: { status: "unresolved" },
            body: { data: [yell], pagination },
          },
          {
            method: "get",
            url: "/api/openappa/yells",
            query: { status: "resolved" },
            body: { data: [], pagination },
          },
          {
            method: "patch",
            url: `/api/openappa/yells/${yell.id}`,
            body: resolvedYell,
          },
        ]);
        const initialList = page.waitForRequest(
          (request) =>
            new URL(request.url()).pathname === "/api/openappa/yells",
        );
        await page.goto("/openappa/yells");
        expect(
          new URL((await initialList).url()).searchParams.get("status"),
        ).toBe("unresolved");
        await expect(
          page.getByText(yell.message, { exact: true }),
        ).toBeVisible();
        if (width === 1280) {
          const status = page.getByRole("combobox", { name: "Yell status" });
          await expect(status).toHaveText("Unresolved");
          await status.click();
          await expect(page.getByRole("option")).toHaveText([
            "Unresolved",
            "Resolved",
          ]);
          const resolvedList = listRequest("resolved");
          await page
            .getByRole("option", { name: "Resolved", exact: true })
            .click();
          await resolvedList;
          await expect(page).toHaveURL(/\/openappa\/yells\?status=resolved$/);
          await page
            .getByRole("button", { name: "Clear", exact: true })
            .click();
          await expect(status).toHaveText("Unresolved");
          await expect(page).toHaveURL(/\/openappa\/yells$/);
        }
        await expect(
          page.getByText(
            "Yells are agent reports of confusing blocks or remedies. Investigate them in chat and mark them resolved once fixed.",
          ),
        ).toBeVisible();
        const table = page.getByRole("table");
        await expect(
          table.getByText(
            serviceAccount ? "Report automation" : "Alex Reporter",
            { exact: true },
          ),
        ).toBeVisible();
        if (serviceAccount) {
          await expect(
            table.getByText("Service account", { exact: true }),
          ).toHaveCount(0);
          await table.getByTitle("Report automation · Service account").hover();
          await expect(page.getByRole("tooltip")).toHaveText(
            "Report automation · Service account",
          );
          await page.getByPlaceholder("Search reports").hover();
        }
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
        const action = page.getByRole("button", {
          name: "Investigate in chat",
        });
        await expect(action).toBeInViewport({ ratio: 1 });
        await mswControl.registerMany([
          {
            method: "get",
            url: "/api/openappa/yells",
            query: { status: "unresolved" },
            body: { data: [], pagination },
          },
          {
            method: "get",
            url: "/api/openappa/yells",
            query: { status: "resolved" },
            body: { data: [resolvedYell], pagination },
          },
        ]);
        await page
          .getByRole("button", { name: "Mark resolved", exact: true })
          .click();
        await expect(page.getByText("Yell marked resolved")).toBeVisible();
        await expect(page.getByText("No unresolved yells")).toBeVisible();
        const sharedLink = listRequest("resolved");
        await page.goto("/openappa/yells?status=resolved");
        await sharedLink;
        await expect(
          page.getByText(yell.message, { exact: true }),
        ).toBeVisible();
        await mswControl.registerMany([
          {
            method: "get",
            url: "/api/openappa/yells",
            query: { status: "unresolved" },
            body: { data: [yell], pagination },
          },
          {
            method: "get",
            url: "/api/openappa/yells",
            query: { status: "resolved" },
            body: { data: [], pagination },
          },
          {
            method: "patch",
            url: `/api/openappa/yells/${yell.id}`,
            body: yell,
          },
        ]);
        await page.getByRole("button", { name: "Reopen", exact: true }).click();
        await expect(page.getByText("Yell reopened")).toBeVisible();
        await expect(page.getByText(yell.message, { exact: true })).toHaveCount(
          0,
        );
        await page.goto("/openappa/yells");
        await expect(
          page.getByRole("button", { name: "Mark resolved", exact: true }),
        ).toBeVisible();
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
        const report = page.getByText(yell.message, { exact: true });
        await expect(report).toBeVisible();
        await report.click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
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

test("a diagnostics-only reader reaches Yells without fetching policy or settings", async ({
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
        openappaPolicy: [],
        organizationSettings: [],
        openappaDiagnostics: ["read"],
      },
    },
    {
      method: "get",
      url: "/api/openappa/yells",
      body: {
        data: [
          {
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
  await page.goto("/openappa/yells");
  await expect(
    page.getByRole("heading", { name: "Yells Alpha" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Policy", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Batteries", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Guardrails/, exact: false }).first(),
  ).toHaveAttribute("href", "/openappa/yells");
  expect(forbiddenRequests).toEqual([]);
  const investigate = page.getByRole("button", { name: "Investigate in chat" });
  await expect(investigate).toHaveAttribute("aria-disabled", "true");
  await investigate.click({ force: true });
  await expect(page).toHaveURL(/\/openappa\/yells$/);
  await investigate.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Missing permissions");
  await expect(tooltip).toContainText("Chats: create");
  await expect(tooltip).toContainText("OpenAPPA Policy: read");
  await expect(tooltip).not.toContainText("Diagnostics");
  const table = await page.getByRole("table").boundingBox();
  const download = await page
    .getByRole("button", { name: "Download report" })
    .boundingBox();
  expect(table).not.toBeNull();
  expect(download).not.toBeNull();
  if (!table || !download) throw new Error("Table and action must be visible");
  expect(download.x + download.width).toBeLessThanOrEqual(
    table.x + table.width - 8,
  );
  await page.screenshot({ path: testInfo.outputPath("yells-permissions.png") });
});
