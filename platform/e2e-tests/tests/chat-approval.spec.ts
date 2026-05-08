import type { Page } from "@playwright/test";
import { E2eTestId, MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { WIREMOCK_BASE_URL, WIREMOCK_INTERNAL_URL } from "../consts";
import { expect, goToPage, test } from "../fixtures";
import { makeApiRequest } from "../utils/mcp-gateway";
import { LLM_PROVIDER_API_KEYS_AVAILABLE_ROUTE } from "./api-fixtures";

/**
 * Chat - Approval flow survives reload
 *
 * After Approve or Decline on a tool call, refreshing the chat must not
 * bring back the "Approval required" banner. Drives WireMock LLM stubs
 * keyed on TEST_MESSAGE_TAG; the stubs use isolated scenarios
 * (auth-ui-approval-e2e / gemini-auth-ui-approval-e2e) so we do not
 * collide with chat-auth-required.spec.ts and can reset state per test.
 */
test.describe.configure({ mode: "serial" });

test.describe("Chat - Approval flow survives reload", () => {
  test.setTimeout(120_000);

  // Catalog name MUST match the existing WireMock mappings under
  // `helm/e2e-tests/mappings/mcp-auth-ui-e2e-*.json`. LLM stubs use a
  // dedicated tag + scenario (see `*-chat-auth-ui-approval-e2e-*.json`)
  // so this spec does not share scenario state with chat-auth-required.
  const CATALOG_NAME = "auth-ui-e2e";
  const MCP_TOOL_BASE_NAME = "test_ui_auth_tool";
  const FULL_TOOL_NAME = `${CATALOG_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${MCP_TOOL_BASE_NAME}`;
  const WIREMOCK_MCP_PATH = `/mcp/${CATALOG_NAME}`;
  const TEST_MESSAGE_TAG = "auth-calltime-ui-approval-e2e";
  const APPROVAL_SCENARIOS = [
    "auth-ui-approval-e2e",
    "gemini-auth-ui-approval-e2e",
  ];

  let catalogItemId: string | null = null;
  let catalogItemCreatedHere = false;
  let serverId: string | null = null;
  let agentId: string | null = null;
  let policyId: string | null = null;
  let chatApiKeyId: string | null = null;
  let toolDbId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // 1. Pick an available LLM key. The Anthropic WireMock stub returns the
    //    tool_use response we need; prefer that. Fall back to whatever is
    //    available (mappings exist for both Anthropic and Gemini).
    const availableKeysResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: LLM_PROVIDER_API_KEYS_AVAILABLE_ROUTE,
    });
    const availableKeys = (await availableKeysResponse.json()) as Array<{
      id: string;
      provider: string;
      bestModelId?: string | null;
    }>;
    const preferred =
      availableKeys.find((k) => k.provider === "anthropic") ??
      availableKeys.find((k) => k.provider === "gemini");
    if (!preferred) {
      throw new Error(
        "Expected an available Anthropic or Gemini key for chat-approval e2e",
      );
    }
    chatApiKeyId = preferred.id;

    // 2. Create the catalog item pointing at WireMock if it does not already
    //    exist (chat-auth-required.spec.ts uses the same name).
    const existingCatalog = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/internal_mcp_catalog",
      ignoreStatusCheck: true,
    });
    if (existingCatalog.ok()) {
      const data = await existingCatalog.json();
      const items = Array.isArray(data) ? data : (data?.data ?? []);
      const found = items.find(
        (entry: { name?: string; id?: string }) => entry?.name === CATALOG_NAME,
      );
      if (found?.id) {
        catalogItemId = found.id as string;
      }
    }
    if (!catalogItemId) {
      const catalogResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/internal_mcp_catalog",
        data: {
          name: CATALOG_NAME,
          description: "Approval flow regression spec (#4030)",
          serverType: "remote",
          serverUrl: `${WIREMOCK_INTERNAL_URL}${WIREMOCK_MCP_PATH}`,
        },
      });
      const catalog = await catalogResponse.json();
      catalogItemId = catalog.id;
      catalogItemCreatedHere = true;
    }

    // 3. Install the MCP server (admin, personal scope).
    const installResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server",
      data: { name: CATALOG_NAME, catalogId: catalogItemId },
    });
    const server = await installResponse.json();
    serverId = server.id;

    // 4. Wait for tool discovery.
    let discoveredTool: { id: string; name: string } | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      const toolsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/tools",
      });
      const toolsData = await toolsResponse.json();
      const tools = Array.isArray(toolsData)
        ? toolsData
        : (toolsData.data ?? []);
      discoveredTool = tools.find(
        (t: { name: string }) => t.name === FULL_TOOL_NAME,
      );
      if (discoveredTool) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!discoveredTool) {
      throw new Error(
        `Tool '${FULL_TOOL_NAME}' not discovered. Check WireMock at ${WIREMOCK_MCP_PATH}`,
      );
    }
    toolDbId = discoveredTool.id;

    // 5. Create an agent (personal scope) bound to the LLM key.
    const agentResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agents",
      data: {
        name: `Approval E2E Agent ${Date.now()}`,
        teams: [],
        agentType: "agent",
        scope: "personal",
        llmApiKeyId: chatApiKeyId,
      },
    });
    const agent = await agentResponse.json();
    agentId = agent.id;

    // 6. Assign the discovered tool to the agent. Remote MCP tools require
    //    either an install or call-time credential resolution; we pick the
    //    latter to mirror chat-auth-required.spec.ts. The require_approval
    //    policy still gates execution.
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/agents/${agentId}/tools/${toolDbId}`,
      data: { resolveAtCallTime: true, credentialResolutionMode: "dynamic" },
    });

    // 7. Attach a `require_approval` invocation policy to the tool. The
    //    typed fixture omits this action, so POST directly via makeApiRequest.
    const policyResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/autonomy-policies/tool-invocation",
      data: {
        toolId: toolDbId,
        conditions: [],
        action: "require_approval",
        reason: "Approval flow e2e",
      },
    });
    const policy = await policyResponse.json();
    policyId = policy.id;
  });

  test.beforeEach(async ({ request }) => {
    // Both approval tests reuse the same stateful WireMock scenarios. Reset
    // each one to "Started" via PUT /__admin/scenarios/{name}/state (the only
    // shape that exists in WireMock 3.13.1 — POST /state with a body returns
    // 404, and there is no per-scenario GET endpoint). Throw on non-2xx, then
    // verify the state actually flipped by reading the list endpoint, so a
    // misconfigured admin API fails fast here instead of manifesting as a 60s
    // "Approval required" timeout downstream. Addresses #4164 review feedback.
    const targets = new Set(APPROVAL_SCENARIOS);
    await Promise.all(
      APPROVAL_SCENARIOS.map(async (name) => {
        const stateUrl = `${WIREMOCK_BASE_URL}/__admin/scenarios/${name}/state`;
        const resetResp = await request.put(stateUrl);
        if (!resetResp.ok()) {
          throw new Error(
            `[chat-approval] WireMock reset for scenario '${name}' returned ${resetResp.status()} ${resetResp.statusText()}`,
          );
        }
      }),
    );

    const listResp = await request.get(
      `${WIREMOCK_BASE_URL}/__admin/scenarios`,
    );
    if (!listResp.ok()) {
      throw new Error(
        `[chat-approval] WireMock GET /scenarios returned ${listResp.status()} ${listResp.statusText()}`,
      );
    }
    const listJson = (await listResp.json()) as {
      scenarios?: Array<{ name?: string; state?: string }>;
    };
    const seen = new Map<string, string>();
    for (const s of listJson.scenarios ?? []) {
      if (s.name && targets.has(s.name)) {
        seen.set(s.name, s.state ?? "");
      }
    }
    for (const name of APPROVAL_SCENARIOS) {
      const state = seen.get(name);
      if (state === undefined) {
        throw new Error(
          `[chat-approval] WireMock scenario '${name}' is not registered — check helm/e2e-tests/mappings/*-approval-e2e-*.json are loaded`,
        );
      }
      if (state !== "Started") {
        throw new Error(
          `[chat-approval] WireMock scenario '${name}' did not reset — current state '${state}'`,
        );
      }
    }
  });

  test.afterAll(async ({ request }) => {
    if (policyId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/autonomy-policies/tool-invocation/${policyId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
    if (agentId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/agents/${agentId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
    if (serverId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/mcp_server/${serverId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
    if (catalogItemId && catalogItemCreatedHere) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/internal_mcp_catalog/${catalogItemId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
  });

  /**
   * Drives the UI to the point where the approval banner is visible.
   * Returns the page URL once the chat conversation has been created
   * (so callers can reload it).
   */
  async function triggerApprovalBanner(
    page: import("@playwright/test").Page,
  ): Promise<string> {
    if (!agentId) throw new Error("agentId not initialised");
    await goToPage(page, `/chat?agentId=${agentId}`);
    await page.waitForLoadState("domcontentloaded");

    const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    // Send the prompt with the magic tag matched by the WireMock LLM stub.
    await textarea.fill(
      `Test ${TEST_MESSAGE_TAG} ${Date.now()}: please call the tool.`,
    );
    await page.keyboard.press("Enter");

    // The approval banner should appear once the LLM stub returns tool_use.
    await expect(page.getByText(/Approval required/i)).toBeVisible({
      timeout: 60_000,
    });

    // Wait for navigation to /chat/{conversationId} so we have a stable URL
    // to reload. Once the conversation exists the URL is updated by
    // router.push.
    await expect
      .poll(() => page.url(), { timeout: 15_000 })
      .toMatch(/\/chat\/[\w-]+/);

    return page.url();
  }

  /**
   * Wait for the backend persistence sweep to finish before reloading.
   *
   * The frontend banner clears the moment the SDK transitions the tool
   * part locally — milliseconds after Approve/Decline. Backend `onFinish`
   * runs `persistNewMessages` async and only finishes ~2s later (sweep +
   * new assistant insert). Reloading before the sweep completes captures
   * the stale `approval-requested` row and re-renders the banner. Poll the
   * conversation API until the persisted tool part is in a terminal state
   * so the spec actually exercises the post-sweep DB state.
   *
   * Decline can transition through `output-denied`, but in some flows the
   * sweep deletes the row outright and the next assistant message has no
   * tool part. Treat "no tool part present" as terminal too so the helper
   * doesn't time out on that branch.
   */
  async function waitForToolPartTerminalState(page: Page): Promise<void> {
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const url = window.location.pathname.replace(
              /^\/chat\//,
              "/api/chat/conversations/",
            );
            const r = await fetch(url, { credentials: "include" });
            if (!r.ok) return null;
            const body = (await r.json()) as {
              messages?: Array<{
                role?: string;
                parts?: Array<{ type?: string; state?: string }>;
              }>;
            };
            const toolPart = (body.messages ?? [])
              .flatMap((m) => m.parts ?? [])
              .find(
                (p) =>
                  typeof p?.type === "string" && p.type.startsWith("tool-"),
              );
            if (toolPart === undefined) return "removed";
            return toolPart.state ?? null;
          }),
        { timeout: 30_000 },
      )
      .toMatch(/^(output-available|output-error|output-denied|removed)$/);
  }

  test("Approve survives reload — banner does not reappear", async ({
    page,
  }) => {
    const conversationUrl = await triggerApprovalBanner(page);

    const approveButton = page
      .getByRole("button", { name: /^Approve/i })
      .first();
    await expect(approveButton).toBeVisible({ timeout: 10_000 });
    await approveButton.click();

    // After approve the approval banner must disappear in-memory.
    await expect(page.getByText(/Approval required/i)).toHaveCount(0, {
      timeout: 30_000,
    });

    await waitForToolPartTerminalState(page);

    // Reload and confirm the persistence sweep removed the stale row AND the
    // post-approval assistant response is still rendered (the original
    // user-visible symptom from #4030: "the response disappears").
    await page.goto(conversationUrl);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/Approval required/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Approve/i })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: /^Decline/i })).toHaveCount(
      0,
    );
    // Stub follow-up text from helm/e2e-tests/mappings/*-chat-auth-ui-approval-e2e-followup.json
    await expect(
      page.getByText(/seems you need to set up credentials/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("Decline survives reload — banner does not reappear", async ({
    page,
  }) => {
    const conversationUrl = await triggerApprovalBanner(page);

    const declineButton = page
      .getByRole("button", { name: /^Decline/i })
      .first();
    await expect(declineButton).toBeVisible({ timeout: 10_000 });
    await declineButton.click();

    await expect(page.getByText(/Approval required/i)).toHaveCount(0, {
      timeout: 30_000,
    });

    await waitForToolPartTerminalState(page);

    await page.goto(conversationUrl);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/Approval required/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Approve/i })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: /^Decline/i })).toHaveCount(
      0,
    );
    // Stub follow-up text from helm/e2e-tests/mappings/*-chat-auth-ui-approval-e2e-followup.json
    await expect(
      page.getByText(/seems you need to set up credentials/i),
    ).toBeVisible({ timeout: 10_000 });
  });
});
