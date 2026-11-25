import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { makeOrganization } from "../src/mocks/data/organization";
import { expect, test } from "./fixtures";
import type { MswControl } from "./helpers/msw-control";

const KEY_ID = "00000000-0000-4000-8000-00000000a001";
const MODEL_ID = "00000000-0000-4000-8000-00000000b001";
const openAiKey = makeLlmProviderApiKey({
  id: KEY_ID,
  name: "Company OpenAI",
  provider: "openai",
  scope: "org",
  userId: null,
});
const SETTINGS_URL = "/api/agent-runtime-templates/settings";
const RUNTIME_IDS = [
  "claude-code",
  "codex",
  "opencode",
  "hermes",
  "openclaw",
  "grok",
  "kimi",
  "copilot",
];

test("an administrator sees Codex's two account cards in its editor, fixes its company connection, and clears it again", async ({
  page,
  request,
  mswControl,
}) => {
  await runtimeOn({ request, mswControl });
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/llm-provider-api-keys/available",
      body: [openAiKey],
    },
    // The runtimes save as a whole list. The answer is what was stored, with
    // the connection's name filled in.
    {
      method: "put",
      url: SETTINGS_URL,
      body: savedSettings({
        llmApiKeyId: KEY_ID,
        keyName: "Company OpenAI",
        keyProvider: "openai",
      }),
    },
  ]);
  await page.goto("/settings/agents/runtimes");

  const openCodex = async () => {
    await page.getByRole("button", { name: "Actions for Codex" }).click();
    await page.getByRole("menuitem", { name: "Edit runtime" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Codex runtime" });
    await dialog.getByRole("button", { name: "Runtime settings" }).click();
    return dialog;
  };
  const savedBody = () =>
    page.waitForRequest(
      (sent) => sent.method() === "PUT" && sent.url().endsWith(SETTINGS_URL),
    );

  // The cards an agent on Codex shows, under the same heading. Neither kind
  // is named until an administrator chooses, so both are selected.
  let dialog = await openCodex();
  await expect(
    dialog.getByRole("heading", { name: "Accounts that can run it" }),
  ).toBeVisible();
  const accounts = dialog.getByRole("group", {
    name: "Accounts that can run it",
  });
  await expect(
    accounts.getByRole("checkbox", {
      name: /Each person's ChatGPT subscription/,
    }),
  ).toBeChecked();
  await expect(
    accounts.getByRole("checkbox", { name: /A company API key/ }),
  ).toBeChecked();
  await expect(
    dialog.getByText(
      "People who create or edit an agent on this runtime choose whether it allows personal subscriptions, a company API key, or both.",
    ),
  ).toBeVisible();
  // Its connection and model are optional: left empty, each agent sets its own.
  await expect(
    dialog.getByText(
      "Optional. Set a connection and model to fix them for every agent on this runtime. Leave them empty to set them in each agent's settings.",
    ),
  ).toBeVisible();
  await expect(accounts.getByRole("button", { name: /^Model/ })).toBeDisabled();

  // Fix the connection.
  await accounts
    .getByRole("button", { name: /^Which connection pays/ })
    .click();
  await page.getByRole("option", { name: /Company OpenAI/ }).click();
  await expect(
    accounts.getByRole("button", {
      name: "Which connection pays Company OpenAI",
    }),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "Every agent on this runtime uses this connection. Set the model in each agent's settings, or set it here.",
    ),
  ).toBeVisible();
  const fixed = savedBody();
  await dialog.getByRole("button", { name: "Save runtime" }).click();
  expect((await fixed).postDataJSON().builtIns.codex.settings.accounts).toEqual(
    { llmApiKeyId: KEY_ID },
  );
  // Saving does not close the settings: the toast confirms it, and with
  // nothing unsaved the footer's way out reads Close.
  await expectSavedAndOpen(page, dialog);
  await expect(
    dialog.getByRole("button", {
      name: "Which connection pays Company OpenAI",
    }),
  ).toBeVisible();
  await footerClose(dialog).click();
  await expect(dialog).toHaveCount(0);

  // Reopened, it shows the fixed connection, with a control that clears it.
  await mswControl.use({
    method: "put",
    url: SETTINGS_URL,
    body: savedSettings(undefined),
  });
  dialog = await openCodex();
  await expect(
    dialog.getByRole("button", {
      name: "Which connection pays Company OpenAI",
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Clear connection" }).click();
  await expect(
    dialog.getByText(
      "Optional. Set a connection and model to fix them for every agent on this runtime. Leave them empty to set them in each agent's settings.",
    ),
  ).toBeVisible();
  // An unsaved change: the footer's way out reads Cancel until it is saved.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  const cleared = savedBody();
  await dialog.getByRole("button", { name: "Save runtime" }).click();
  expect(
    (await cleared).postDataJSON().builtIns.codex.settings,
  ).not.toHaveProperty("accounts");
  await expectSavedAndOpen(page, dialog);
  await expect(
    dialog.getByText(
      "Optional. Set a connection and model to fix them for every agent on this runtime. Leave them empty to set them in each agent's settings.",
    ),
  ).toBeVisible();
});

test("an administrator sees both account cards on the Claude Code runtime with nothing stored, and names one kind in its rule", async ({
  page,
  request,
  mswControl,
}) => {
  await runtimeOn({ request, mswControl });
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/llm-provider-api-keys/available",
      body: [],
    },
    {
      method: "put",
      url: SETTINGS_URL,
      body: {
        ...savedSettings(undefined),
        builtIns: {
          "claude-code": {
            settings: {
              claudeCode: { authentication: "provider" },
              accounts: { kind: "key" },
            },
          },
        },
      },
    },
  ]);
  await page.goto("/settings/agents/runtimes");
  await page.getByRole("button", { name: "Actions for Claude Code" }).click();
  await page.getByRole("menuitem", { name: "Edit runtime" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Claude Code runtime" });
  await dialog.getByRole("button", { name: "Runtime settings" }).click();

  // Nothing is stored, so the runtime names no kind: both cards.
  const accounts = dialog.getByRole("group", {
    name: "Accounts that can run it",
  });
  const subscription = accounts.getByRole("checkbox", {
    name: /Each person's Claude subscription/,
  });
  await expect(subscription).toBeChecked();
  await expect(
    accounts.getByRole("checkbox", { name: /A company API key/ }),
  ).toBeChecked();
  // The rule reaches every agent on save; the update is for the limits.
  await expect(
    dialog.getByText(
      "Allowed accounts apply to every agent on this runtime as soon as you save. Limit changes apply to new agents, and to existing agents once you update them here.",
    ),
  ).toBeVisible();

  // One card left names that kind for every agent of the runtime.
  await subscription.click();
  await expect(dialog.getByText("Locked to a company API key")).toBeVisible();
  const saved = page.waitForRequest(
    (sent) => sent.method() === "PUT" && sent.url().endsWith(SETTINGS_URL),
  );
  await dialog.getByRole("button", { name: "Save runtime" }).click();
  expect(
    (await saved).postDataJSON().builtIns["claude-code"].settings,
  ).toMatchObject({
    accounts: { kind: "key" },
    claudeCode: { authentication: "provider" },
  });
  // The settings stay open on the rule just saved.
  await expectSavedAndOpen(page, dialog);
  await expect(dialog.getByText("Locked to a company API key")).toBeVisible();
  await expect(subscription).not.toBeChecked();
});

test("someone who may only use a runtime that fixes a connection and model sees both fields disabled, with the note, on a new agent", async ({
  page,
  request,
  mswControl,
}) => {
  await runtimeOn({ request, mswControl });
  await mswControl.registerMany([
    // They may put agents on every runtime, and configure none.
    {
      method: "get",
      url: "/api/agent-runtime-templates/access",
      body: {
        runtimes: RUNTIME_IDS.map((id) => ({
          id,
          canUse: true,
          canConfigure: false,
        })),
        canConfigureAny: false,
      },
    },
    // OpenCode fixes its agents' connection and model. The names are filled
    // in by the server: the connection is not one this person can read.
    {
      method: "get",
      url: "/api/agent-runtime-templates/built-ins",
      body: [
        {
          id: "opencode",
          settings: {
            accounts: {
              llmApiKeyId: KEY_ID,
              modelId: MODEL_ID,
              keyName: "Company OpenAI",
              keyProvider: "openai",
              modelName: "GPT-5",
            },
          },
        },
      ],
    },
  ]);
  await page.goto("/agents/new");
  await page.getByRole("button", { name: /OpenCode/ }).click();
  await expect(page.getByRole("textbox", { name: /^Name\b/ })).toBeVisible();

  // The runtime's one account, on the connection and model it fixes.
  const row = page.getByRole("button", { name: /^Accounts that can run it/ });
  await expect(row).toContainText("Company OpenAI, GPT-5");
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  const accounts = page.getByRole("group", {
    name: "Accounts that can run it",
  });
  await expect(
    accounts.getByRole("button", {
      name: "Which connection pays Company OpenAI",
    }),
  ).toBeDisabled();
  await expect(
    accounts.getByRole("button", { name: "Model GPT-5" }),
  ).toBeDisabled();
  await expect(
    accounts.getByText("An admin locked this connection and model."),
  ).toBeVisible();
  // The notice names them as the runtime's to change.
  await expect(
    page.getByText("Set by the OpenCode runtime").locator("xpath=.."),
  ).toContainText(
    "limits, tiers, accounts, connection or model needs agentRuntime:configure on it.",
  );
});

/** The footer's way out. The dialog's own X is named Close too, and comes first. */
function footerClose(dialog: Locator) {
  return dialog.getByRole("button", { name: "Close" }).last();
}

/**
 * What a save leaves: the settings still open, the toast that says it
 * worked, nothing unsaved, and Save ready for the next change.
 */
async function expectSavedAndOpen(page: Page, dialog: Locator) {
  await expect(page.getByText("Available runtimes updated")).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(footerClose(dialog)).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Save runtime" }),
  ).toBeEnabled();
}

/** Agent Runtime on, as on a deployment that runs agents in containers. */
async function runtimeOn({
  request,
  mswControl,
}: {
  request: APIRequestContext;
  mswControl: MswControl;
}) {
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/config",
      body: {
        ...config,
        features: {
          ...config.features,
          agentRuntime: true,
          agentRuntimeBackend: {
            ...config.features.agentRuntimeBackend,
            available: true,
          },
        },
      },
    },
    { method: "get", url: "/api/organization", body: makeOrganization() },
    // Agent Runtime on: the sidebar lists runs.
    {
      method: "get",
      url: "/api/agent-runs",
      body: { data: [], pagination: {} },
    },
    // A runtime's editor counts its agents on older settings: none here.
    {
      method: "get",
      url: "/api/agent-runtime-templates/:id/apply-to-agents",
      body: { agents: 0 },
    },
  ]);
}

/** The runtime list as stored, with what Codex fixes for its agents. */
function savedSettings(accounts: object | undefined) {
  return {
    revision: 1,
    templates: [],
    builtIns: { codex: { settings: accounts ? { accounts } : {} } },
    popularAgentOverrides: makeOrganization().popularAgentOverrides,
  };
}
