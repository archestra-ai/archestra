import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { makeUserPermissions } from "../src/mocks/data/auth";
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
    { method: "get", url: SETTINGS_URL, body: savedSettings(undefined) },
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

  const openCodex = () => openAccounts(page, "Codex");
  const savedBody = () =>
    page.waitForRequest(
      (sent) => sent.method() === "PUT" && sent.url().endsWith(SETTINGS_URL),
    );

  // The cards an agent on Codex shows, under the same heading. Neither kind
  // is named until an administrator chooses, so both are selected.
  let dialog = await openCodex();
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
  // Saving closes the settings, as before.
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
  const cleared = savedBody();
  await dialog.getByRole("button", { name: "Save runtime" }).click();
  expect(
    (await cleared).postDataJSON().builtIns.codex.settings,
  ).not.toHaveProperty("accounts");
  await expect(dialog).toHaveCount(0);
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
    { method: "get", url: SETTINGS_URL, body: savedSettings(undefined) },
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
  const dialog = await openAccounts(page, "Claude Code");

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
  await expect(
    dialog.getByText(
      "Which accounts agents on this runtime may allow. Changes apply to every agent as soon as you save.",
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
  await expect(dialog).toHaveCount(0);
});

test("a runtime that fixes a connection and model shows both fields disabled, with the note, on a new agent", async ({
  page,
  request,
  mswControl,
}) => {
  await runtimeOn({ request, mswControl });
  await mswControl.registerMany([
    // They may build agents on runtimes, and may not set a runtime's rule.
    {
      method: "get",
      url: "/api/user/permissions",
      body: makeUserPermissions({
        agent: ["read", "create", "update", "delete", "configure-runtime"],
        organizationSettings: ["read"],
      }),
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
});

/** Opens a maintained runtime's settings on its accounts. */
async function openAccounts(page: Page, name: string): Promise<Locator> {
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Edit runtime" }).click();
  const dialog = page.getByRole("dialog", { name: `Edit ${name} runtime` });
  await dialog
    .getByRole("button", { name: /^Accounts that can run it/ })
    .click();
  return dialog;
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
