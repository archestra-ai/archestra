import { expect, test } from "../fixtures";
import { waitForElementWithReload } from "../utils";

const TEMPLATE_CATALOG_TITLE = "Agent Template Catalog";
const FROM_TEMPLATE_BUTTON_TEXT = "From Template";

const templates = [
  {
    id: "ops-engineer",
    name: "Ops Engineer",
    description:
      "Investigates agent behavior, MCP connectivity, and usage limits with built-in platform tools.",
    type: "agent",
    categories: ["operations", "internal-tools"],
    systemPrompt: "You are an operations engineer working inside the platform.",
    llmModel: null,
    tools: [
      "archestra__list_agents",
      "archestra__get_mcp_servers",
      "archestra__get_limits",
    ],
    labels: [
      { key: "template", value: "ops-engineer" },
      { key: "persona", value: "operations" },
    ],
    icon: "🛠️",
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description:
      "Reviews repositories and issues, then summarizes correctness risks and follow-up actions.",
    type: "agent",
    categories: ["engineering", "collaboration"],
    systemPrompt: "You are a careful code reviewer.",
    llmModel: null,
    tools: ["github__*"],
    labels: [
      { key: "template", value: "code-reviewer" },
      { key: "persona", value: "review" },
    ],
    icon: "🔎",
  },
  {
    id: "general-purpose",
    name: "General Purpose",
    description:
      "Starts with no tool assignments so the agent can be customized after creation.",
    type: "agent",
    categories: ["general"],
    systemPrompt:
      "You are a general-purpose assistant. Ask clarifying questions when requirements are ambiguous.",
    llmModel: null,
    tools: [],
    labels: [],
    icon: "✨",
  },
] as const;

async function openTemplateCatalog(
  page: import("@playwright/test").Page,
  goToPage: (
    page: import("@playwright/test").Page,
    path?: string,
  ) => Promise<void>,
) {
  await goToPage(page, "/agents");
  await page.waitForLoadState("domcontentloaded");

  const fromTemplateBtn = page.getByRole("button", {
    name: FROM_TEMPLATE_BUTTON_TEXT,
  });
  await waitForElementWithReload(page, fromTemplateBtn, { timeout: 20_000 });
  await fromTemplateBtn.click();

  const dialog = page.getByRole("dialog", { name: TEMPLATE_CATALOG_TITLE });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

async function stubTemplateApis(page: import("@playwright/test").Page) {
  await page.route("**/api/agent_templates", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(templates),
    });
  });

  await page.route("**/api/agent_templates/*/requirements", async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(
      /\/api\/agent_templates\/([^/]+)\/requirements$/,
    );
    const templateId = match?.[1];

    await new Promise((resolve) => setTimeout(resolve, 300));

    const bodyByTemplateId: Record<string, unknown> = {
      "general-purpose": {
        templateId: "general-purpose",
        agentConfig: {
          name: "General Purpose",
          description:
            "Starts with no tool assignments so the agent can be customized after creation.",
          systemPrompt:
            "You are a general-purpose assistant. Ask clarifying questions when requirements are ambiguous.",
          llmModel: null,
          labels: [],
          agentType: "agent",
          scope: "personal",
          teams: [],
        },
        toolAssignments: [],
        missingCatalogs: [],
        unavailableTools: [],
      },
      "ops-engineer": {
        templateId: "ops-engineer",
        agentConfig: {
          name: "Ops Engineer",
          description:
            "Investigates agent behavior, MCP connectivity, and usage limits with built-in platform tools.",
          systemPrompt:
            "You are an operations engineer working inside the platform.",
          llmModel: null,
          labels: [
            { key: "template", value: "ops-engineer" },
            { key: "persona", value: "operations" },
          ],
          agentType: "agent",
          scope: "personal",
          teams: [],
        },
        toolAssignments: [
          {
            toolId: "tool-list-agents",
            catalogId: null,
            requiresUserConfig: false,
          },
        ],
        missingCatalogs: [],
        unavailableTools: [],
      },
      "code-reviewer": {
        templateId: "code-reviewer",
        agentConfig: {
          name: "Code Reviewer",
          description:
            "Reviews repositories and issues, then summarizes correctness risks and follow-up actions.",
          systemPrompt: "You are a careful code reviewer.",
          llmModel: null,
          labels: [
            { key: "template", value: "code-reviewer" },
            { key: "persona", value: "review" },
          ],
          agentType: "agent",
          scope: "personal",
          teams: [],
        },
        toolAssignments: [],
        missingCatalogs: [
          {
            catalogId: "github-catalog",
            catalogName: "github",
            serverType: "remote",
            requiresOauth: false,
            userConfigFields: [
              {
                key: "token",
                type: "string",
                title: "Token",
                description: "API token",
                required: true,
              },
            ],
            environmentFields: [
              {
                key: "GITHUB_HOST",
                type: "plain_text",
                promptOnInstallation: true,
                description: "Host override",
              },
            ],
            canAutoInstall: false,
          },
        ],
        unavailableTools: [],
      },
    };

    const body = templateId ? bodyByTemplateId[templateId] : null;
    if (!body) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "Not found", type: "not_found" },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.route("**/api/agents", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    const requestBody = route.request().postDataJSON() as { name?: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: `agent-${requestBody.name?.toLowerCase().replace(/\s+/g, "-") ?? "created"}`,
        name: requestBody.name ?? "Created Agent",
      }),
    });
  });

  await page.route("**/api/agents/tools/bulk-assign", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        succeeded: [],
        failed: [],
        duplicates: [],
      }),
    });
  });

  await page.route("**/api/mcp_server", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      catalogId?: string;
      name?: string;
    };
    const serverId =
      requestBody.catalogId === "slack-catalog"
        ? "server-slack"
        : "server-installed";

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: serverId,
        name: requestBody.name ?? "Installed Server",
        catalogId: requestBody.catalogId ?? null,
      }),
    });
  });
}

test.describe("Agent Template Catalog", () => {
  test.beforeEach(async ({ page }) => {
    await stubTemplateApis(page);
  });

  test("happy path creates an auto-provisioned template agent", {
    tag: ["@firefox", "@webkit"],
  }, async ({ page, goToPage }) => {
    test.setTimeout(120_000);

    const catalogDialog = await openTemplateCatalog(page, goToPage);

    const opsEngineerCard = catalogDialog
      .locator("[data-slot='card']")
      .filter({ hasText: "Ops Engineer" })
      .first();
    await expect(opsEngineerCard).toBeVisible({ timeout: 15_000 });

    await opsEngineerCard.getByRole("button", { name: "Use Template" }).click();

    const loadingDialog = page.getByRole("dialog", {
      name: "Creating Ops Engineer",
    });
    await expect(loadingDialog).toBeVisible({ timeout: 10_000 });

    await expect(loadingDialog.getByText("Preparing agent...")).toBeVisible({
      timeout: 10_000,
    });

    await expect(loadingDialog).not.toBeVisible({ timeout: 30_000 });
    await page.waitForURL(/\/chat$/);
  });

  test("general-purpose template shows no-tool details and creates directly", {
    tag: ["@firefox", "@webkit"],
  }, async ({ page, goToPage }) => {
    test.setTimeout(90_000);

    const catalogDialog = await openTemplateCatalog(page, goToPage);

    const generalPurposeCard = catalogDialog
      .locator("[data-slot='card']")
      .filter({ hasText: "General Purpose" })
      .first();
    await expect(generalPurposeCard).toBeVisible({ timeout: 15_000 });
    await expect(generalPurposeCard.getByText("0 tools")).toBeVisible();

    await generalPurposeCard.getByRole("button", { name: "Preview" }).click();

    const detailsDialog = page.getByRole("dialog", { name: "General Purpose" });
    await expect(detailsDialog).toBeVisible({ timeout: 10_000 });
    await expect(detailsDialog.getByText("No tools assigned.")).toBeVisible();
    await expect(detailsDialog.getByText("No labels.")).toBeVisible();

    await detailsDialog.getByRole("button", { name: /close/i }).click();
    await expect(detailsDialog).not.toBeVisible({ timeout: 5_000 });

    await generalPurposeCard
      .getByRole("button", { name: "Use Template" })
      .click();

    const loadingDialog = page.getByRole("dialog", {
      name: "Creating General Purpose",
    });
    await expect(loadingDialog).toBeVisible({ timeout: 10_000 });

    await expect(loadingDialog).not.toBeVisible({ timeout: 30_000 });
    await page.waitForURL(/\/chat$/);
  });

  test("details dialog shows final template fields", {
    tag: ["@firefox", "@webkit"],
  }, async ({ page, goToPage }) => {
    test.setTimeout(60_000);

    const catalogDialog = await openTemplateCatalog(page, goToPage);

    await catalogDialog
      .locator("[data-slot='card']")
      .filter({ hasText: "Code Reviewer" })
      .getByRole("button", { name: "Preview" })
      .click();

    const detailsDialog = page.getByRole("dialog", { name: "Code Reviewer" });
    await expect(detailsDialog).toBeVisible({ timeout: 10_000 });

    await expect(detailsDialog.getByText("System Prompt")).toBeVisible();
    await expect(detailsDialog.getByRole("heading", { name: "Tools" })).toBeVisible();
    await expect(detailsDialog.getByText("Labels")).toBeVisible();
    await expect(
      detailsDialog.getByText("All tools from Github"),
    ).toBeVisible();
    await expect(
      detailsDialog.getByText("template: code-reviewer"),
    ).toBeVisible();
  });

  test("config form prompts for manual catalog input before creation", {
    tag: ["@firefox", "@webkit"],
  }, async ({ page, goToPage }) => {
    test.setTimeout(60_000);

    const catalogDialog = await openTemplateCatalog(page, goToPage);

    await catalogDialog
      .locator("[data-slot='card']")
      .filter({ hasText: "Code Reviewer" })
      .getByRole("button", { name: "Use Template" })
      .click();

    const loadingDialog = page.getByRole("dialog", {
      name: "Creating Code Reviewer",
    });
    await expect(loadingDialog).toBeVisible({ timeout: 10_000 });
    await expect(loadingDialog.getByText("Preparing agent...")).toBeVisible({
      timeout: 10_000,
    });

    await expect(loadingDialog.getByText("Preparing agent...")).not.toBeVisible({
      timeout: 10_000,
    });

    const createDialog = page.getByRole("dialog", {
      name: "Create Code Reviewer",
    });
    await expect(createDialog).toBeVisible({ timeout: 10_000 });
    await expect(createDialog.getByLabel("Token")).toBeVisible({
      timeout: 10_000,
    });
    await expect(createDialog.getByLabel("GITHUB_HOST")).toBeVisible();

    await createDialog.getByLabel("Token").fill("secret-token");
    await createDialog.getByLabel("GITHUB_HOST").fill("github.example.com");
    await expect(
      createDialog.getByRole("button", { name: "Create Agent" }),
    ).toBeVisible();
  });
});
