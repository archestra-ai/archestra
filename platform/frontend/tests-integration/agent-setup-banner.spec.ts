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
  accountError: null,
  accountErrorFromChoice: false,
  accountErrorFromModel: false,
  accountErrorFromConnection: false,
  companyAccountIsPlan: false,
  missingSubscription: null,
};

const NEEDS_CREDENTIAL: Preflight = {
  ...NEEDS_CLAUDE_ACCOUNT,
  missing: [{ key: "API_TOKEN", label: "API token" }],
};

const READY: Preflight = {
  ready: true,
  configured: ["CLAUDE_CODE_ACCOUNT"],
  missing: [],
  misconfigured: [],
  incompatible: null,
  accountError: null,
  accountErrorFromChoice: false,
  accountErrorFromModel: false,
  accountErrorFromConnection: false,
  companyAccountIsPlan: false,
  missingSubscription: null,
};

/** The viewer's runs use their own Claude subscription: the agent's setting. */
const subscriptionAccount = (connected: boolean) => ({
  agentAccount: {
    authentication: "subscription",
    llmApiKeyId: null,
    modelId: null,
  },
  // Nothing is set for the company API key, and nothing resolves for it.
  companyKey: false,
  companyAccount: {
    connection: { id: null, name: null, provider: null, fixedBy: null },
    model: { id: null, name: null, fixedBy: null },
    usesOrganizationDefault: false,
  },
  choice: null,
  choiceError: null,
  lock: null,
  subscription: {
    kind: "claude",
    label: "Claude subscription",
    connected,
    keyId: null,
  },
});

test("spaces the setup checklist like the rest of the agent overview", async ({
  page,
  mswControl,
  request,
}) => {
  await mockAgentPage({ mswControl, request });
  await setAccountState({
    mswControl,
    account: { state: "connected" },
    preflight: NEEDS_CREDENTIAL,
  });
  await page.goto(`/agents/${AGENT.id}?section=general`);

  // A credential the agent still needs is a row of the setup checklist.
  const notice = page.getByRole("status", { name: "Agent setup" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("API token");

  // The checklist is followed by where the agent gets its work, then its
  // instructions. Compare against a gap the page already keeps, not a number
  // from the CSS.
  const workSources = page.getByRole("region", { name: "Give it work" });
  const instructions = page.getByRole("region", { name: "Instructions" });
  const standardGap = await verticalGap(workSources, instructions);
  expect(standardGap).toBeGreaterThan(0);
  expect(await verticalGap(notice, workSources)).toBeCloseTo(standardGap, 0);
});

test("offers the Claude sign-in on the account card, and opens the work sources once the account is connected", async ({
  page,
  mswControl,
  request,
}) => {
  await mockAgentPage({ mswControl, request });
  await page.goto(`/agents/${AGENT.id}?section=general`);

  // The person's own sign-in is not a row of the setup checklist: with
  // nothing else missing there is no checklist.
  const workSources = page.getByRole("region", { name: "Give it work" });
  const summary = workSources.getByText("Uses your personal subscription", {
    exact: true,
  });
  await expect(summary).toBeVisible();
  await expect(page.getByRole("status", { name: "Agent setup" })).toHaveCount(
    0,
  );

  // The account card belongs to "Give it work": it sits under that heading,
  // above the cards, and holds the sign-in.
  const heading = workSources.getByRole("heading", { name: "Give it work" });
  const signIn = workSources.getByRole("button", {
    name: "Sign in",
    exact: true,
  });
  await expect(signIn).toBeVisible();
  const openInChat = workSources.getByText("Open in chat", { exact: true });
  expect(await verticalGap(heading, summary)).toBeGreaterThan(0);
  expect(await verticalGap(summary, openInChat)).toBeGreaterThan(0);
  // Until then a run cannot start, and chat says so instead of opening.
  await expect(workSources).toContainText("Runs start once setup is done.");
  await expect(
    workSources.getByRole("button", { name: "Open in chat" }),
  ).toBeDisabled();

  await connectClaudeAccount(page, mswControl);
  // Signed in, so the card shows their model and the work sources are usable.
  await expect(signIn).toHaveCount(0);
  await expect(
    workSources.getByRole("button", { name: /Opus$/ }),
  ).toBeVisible();
  await expect(
    workSources.getByRole("button", { name: "Disconnect" }),
  ).toBeVisible();
  await expect(workSources).not.toContainText("Runs start once setup is done.");
  await expect(
    workSources.getByRole("link", { name: "Open in chat" }),
  ).toBeVisible();

  // A person's sign-in and model are theirs, on the agent's page. The
  // agent's settings only say which accounts may run it.
  await page.goto(`/agents/${AGENT.id}/edit`);
  await expect(
    page.getByRole("checkbox", { name: /Each person's Claude subscription/ }),
  ).toBeChecked();
  await expect(page.getByText("Signed in for you")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Opus$/ })).toHaveCount(0);
});

test("shows the connection and model that are the person's to pick on the account card, on its one line", async ({
  page,
  mswControl,
  request,
}) => {
  await mockAgentPage({ mswControl, request });
  await setAccountState({
    mswControl,
    account: { state: "connected" },
    preflight: READY,
  });
  // Their runs use the company option, and neither the runtime nor the agent
  // fixes its connection or model: nothing resolves until they pick.
  await mswControl.registerMany([
    {
      method: "get",
      url: `/api/agents/${AGENT.id}/runtime/account`,
      body: {
        ...subscriptionAccount(true),
        choice: {
          authentication: "provider",
          llmApiKeyId: null,
          modelId: null,
          claudeModel: null,
        },
      },
    },
    {
      method: "get",
      url: "/api/llm-provider-api-keys/available",
      body: [],
    },
  ]);
  await page.goto(`/agents/${AGENT.id}?section=general`);

  const workSources = page.getByRole("region", { name: "Give it work" });
  const summary = workSources.getByText("Uses a provider API key", {
    exact: true,
  });
  await expect(summary).toBeVisible();
  const connection = workSources.getByRole("button", {
    name: "Key Choose an API key",
  });
  const model = workSources.getByRole("button", {
    name: "Model Choose a model",
  });
  await expect(connection).toBeEnabled();
  // The model waits for a connection.
  await expect(model).toBeDisabled();
  const switchWay = workSources.getByRole("button", {
    name: "Use personal subscription instead",
  });
  await expect(switchWay).toBeVisible();

  // The line, the two fields and the switch share one line of the card.
  const middle = async (locator: Locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error("not laid out");
    return box.y + box.height / 2;
  };
  const line = await middle(summary);
  for (const part of [connection, model, switchWay]) {
    expect(Math.abs((await middle(part)) - line)).toBeLessThan(6);
  }
});

test("keeps a personal subscription's controls on the right of the account card: disconnect, model, then the other way", async ({
  page,
  mswControl,
  request,
}) => {
  await mockAgentPage({ mswControl, request });
  await setAccountState({
    mswControl,
    account: { state: "connected" },
    preflight: READY,
  });
  // The company API key is open to them too, so the card offers the way to it.
  await mswControl.use({
    method: "get",
    url: `/api/agents/${AGENT.id}/runtime/account`,
    body: { ...subscriptionAccount(true), companyKey: true },
  });
  await page.goto(`/agents/${AGENT.id}?section=general`);

  const workSources = page.getByRole("region", { name: "Give it work" });
  const summary = workSources.getByText("Uses your personal subscription", {
    exact: true,
  });
  const disconnect = workSources.getByRole("button", { name: "Disconnect" });
  const model = workSources.getByRole("button", { name: /Opus$/ });
  const switchWay = workSources.getByRole("button", {
    name: "Use API key instead",
  });
  await expect(model).toBeVisible();
  await expect(switchWay).toBeVisible();

  const box = async (locator: Locator) => {
    const found = await locator.boundingBox();
    if (!found) throw new Error("not laid out");
    return found;
  };
  const [line, first, second, last, card] = await Promise.all(
    [summary, disconnect, model, switchWay, workSources].map(box),
  );
  // One line of the card.
  const middle = line.y + line.height / 2;
  for (const part of [first, second, last]) {
    expect(Math.abs(part.y + part.height / 2 - middle)).toBeLessThan(6);
  }
  // One group, in the order the card reads: the same step from each control
  // to the next, with nothing of the subscription left beside the line.
  const step = second.x - (first.x + first.width);
  expect(step).toBeGreaterThan(0);
  expect(last.x - (second.x + second.width)).toBeCloseTo(step, 0);
  // The group ends at the card's right edge, as far in as the line starts.
  expect(card.x + card.width - (last.x + last.width)).toBeCloseTo(
    line.x - card.x,
    0,
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
  await mswControl.registerMany([
    {
      method: "get",
      url: `/api/agents/${AGENT.id}/tool-exclusions`,
      body: { excludedToolIds: [] },
    },
    {
      method: "get",
      url: `/api/agents/${AGENT.id}/knowledge-source-exclusions`,
      body: { excludedConnectorIds: [] },
    },
    {
      method: "get",
      url: `/api/agents/${AGENT.id}/activation-skill-policy`,
      body: {
        mode: "all",
        revision: 0,
        allowedReferences: [],
        excludedReferences: [],
        hiddenAllowedCount: 0,
        hiddenExcludedCount: 0,
        allowedSkills: [],
        excludedSkills: [],
      },
    },
  ]);
  await mswControl.use({
    method: "get",
    url: `/api/agents/${AGENT.id}/runtime/claude-code/models`,
    body: {
      models: [
        { value: "opus", displayName: "Opus", description: "Runtime default" },
      ],
    },
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
  await mswControl.use({
    method: "get",
    url: `/api/agents/${AGENT.id}/runtime/account`,
    body: subscriptionAccount(account.state === "connected"),
  });
}

/**
 * Opens sign-in from the account card's own action, which starts Claude's
 * flow at once. Once the account connects the agent is ready, and the dialog
 * it opened goes away.
 */
async function connectClaudeAccount(page: Page, mswControl: MswControl) {
  await mswControl.use({
    method: "post",
    url: `/api/agents/${AGENT.id}/runtime/claude-code/account`,
    body: {
      state: "awaiting_code",
      flowId: "00000000-0000-4000-8000-000000000001",
      authorizationUrl: "https://claude.example.test/oauth/authorize",
    },
  });
  await page
    .getByRole("region", { name: "Give it work" })
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  // One click starts Claude's sign-in: the dialog opens on its steps.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("link", { name: "Open Claude" })).toBeVisible();
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
