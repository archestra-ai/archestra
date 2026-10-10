import type { archestraApiTypes } from "@archestra/shared";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { makeAgent } from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";
import type { MswControl } from "./helpers/msw-control";

type Preflight = archestraApiTypes.GetAgentRuntimePreflightResponses["200"];
type Account = archestraApiTypes.GetClaudeCodeAccountResponses["200"];

const AGENT = makeAgent({
  name: "Claude Code",
  runtime: {
    image: "example.com/runtime:1",
    command: ["archestra-claude-code"],
    inferenceProtocol: "anthropic",
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
    idleTimeoutMinutes: null,
    claudeCode: { authentication: "subscription" },
  },
});

const NEEDS_CLAUDE_ACCOUNT: Preflight = {
  ready: false,
  configured: [],
  missing: [
    {
      key: "CLAUDE_CODE_ACCOUNT",
      label: "Claude Code account",
      description:
        "Sign in with your own Claude account in the native runtime.",
    },
  ],
  misconfigured: [],
  incompatible: null,
};

const READY: Preflight = {
  ready: true,
  configured: ["CLAUDE_CODE_ACCOUNT"],
  missing: [],
  misconfigured: [],
  incompatible: null,
};

test("spaces the setup checklist like the rest of the agent page, and clears it once the account is connected", async ({
  page,
  mswControl,
  request,
}) => {
  await mockAgentPage({ mswControl, request });
  await page.goto(`/agents/${AGENT.id}?section=general`);

  // A missing Claude account is a row of the setup checklist.
  const notice = page
    .getByRole("alert")
    .filter({ hasText: "Before this agent can run" });
  const form = page.locator("form").first();
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Connect your Claude subscription");
  await expect(form.getByLabel(/^Name/)).toBeVisible();

  // Compare against a gap the form already keeps, not a number from the CSS.
  const standardGap = await verticalGap(
    form.getByLabel(/^Name/),
    form.locator("label").filter({ hasText: /^Description$/ }),
  );
  expect(standardGap).toBeGreaterThan(0);
  // The checklist is followed by where the agent gets its work, then the form.
  const workSources = page.getByRole("region", { name: "Give it work" });
  expect(await verticalGap(notice, workSources)).toBeCloseTo(standardGap, 0);

  await connectClaudeAccount(page, mswControl);
  // Setup is done, so the checklist goes and the work sources are usable.
  await expect(notice).toHaveCount(0);
  await expect(workSources).not.toContainText(
    "Available once setup above is done.",
  );
});

async function mockAgentPage({
  mswControl,
  request,
}: {
  mswControl: MswControl;
  request: APIRequestContext;
}) {
  const config = (await (
    await request.get("/internal-test/api/api/config")
  ).json()) as { features: Record<string, unknown> };
  await mswControl.use({
    method: "get",
    url: "/api/config",
    body: { ...config, features: { ...config.features, agentRuntime: true } },
  });
  await mswControl.use({
    method: "get",
    url: `/api/agents/${AGENT.id}`,
    body: AGENT,
  });
  await mswControl.use({
    method: "get",
    url: `/api/agents/${AGENT.id}/subagent-exclusions`,
    body: { excludedSubagentIds: [] },
  });
  await mswControl.use({
    method: "get",
    url: `/api/agents/${AGENT.id}/runtime/claude-code/models`,
    body: { models: [] },
  });
  await mswControl.use({
    method: "get",
    url: `/api/agents/${AGENT.id}/runs`,
    body: [],
  });
  await setAccountState({
    mswControl,
    account: { state: "disconnected" },
    preflight: NEEDS_CLAUDE_ACCOUNT,
  });
}

async function setAccountState({
  mswControl,
  account,
  preflight,
}: {
  mswControl: MswControl;
  account: Account;
  preflight: Preflight;
}) {
  await mswControl.use({
    method: "get",
    url: `/api/agents/${AGENT.id}/runtime/preflight`,
    body: preflight,
  });
  await mswControl.use({
    method: "get",
    url: `/api/agents/${AGENT.id}/runtime/claude-code/account`,
    body: account,
  });
}

/**
 * Opens sign-in from the checklist row's own action. Once the account
 * connects the agent is ready, and the dialog it opened goes away.
 */
async function connectClaudeAccount(page: Page, mswControl: MswControl) {
  await page
    .getByRole("alert")
    .getByRole("button", { name: "Sign in with Claude" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await setAccountState({
    mswControl,
    account: { state: "connected" },
    preflight: READY,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function verticalGap(above: Locator, below: Locator) {
  const top = await above.boundingBox();
  const bottom = await below.boundingBox();
  if (!top || !bottom) throw new Error("Both elements must be rendered");
  return bottom.y - (top.y + top.height);
}
