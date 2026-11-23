import type { APIRequestContext } from "@playwright/test";
import { makeAgent, makeAgentCatalog } from "../src/mocks/data/agents";
import { makeUserPermissions } from "../src/mocks/data/auth";
import { makeOrganization } from "../src/mocks/data/organization";
import { expect, test } from "./fixtures";
import type { MswControl } from "./helpers/msw-control";

/** The organization's custom runtime, with a name too long for its badge. */
const TEAM_RUNTIME = {
  id: "00000000-0000-4000-8000-00000000c001",
  name: "Platform engineering review workspace for regulated teams",
  description: "",
  icon: null,
  hidden: false,
  position: 0,
  image: "registry.example.com/platform/review:v3",
};
const TEAM_RUNTIME_SETTINGS = {
  image: TEAM_RUNTIME.image,
  command: ["review-agent"],
  inferenceProtocol: "openai_responses" as const,
  backend: "kubernetes" as const,
  steerMode: "pipe" as const,
  privileged: false as const,
  environment: null,
  credentials: null,
  ttlHours: null,
  idleTimeoutMinutes: null,
};
const ON_TEAM_RUNTIME = makeAgent({
  id: "agent-on-team-runtime",
  name: "Reviewer",
  runtime: TEAM_RUNTIME_SETTINGS,
});
const ON_OWN_IMAGE = makeAgent({
  id: "agent-on-own-image",
  name: "Toolbox",
  runtime: {
    ...TEAM_RUNTIME_SETTINGS,
    image: "ghcr.io/example/toolbox:latest",
    command: null,
  },
});
const WITHOUT_RUNTIME = makeAgent({
  id: "agent-without-runtime",
  name: "Helper",
});

test("someone who administers runtimes sees each agent's runtime named in the table, on one line, and opens its editor from there", async ({
  page,
  request,
  agentsPage,
  mswControl,
}) => {
  await runtimeAgents({ request, mswControl });
  // A narrow table: the name column has little room beside the others.
  await page.setViewportSize({ width: 900, height: 800 });
  await agentsPage.goto();

  const row = agentsPage.rowFor(ON_TEAM_RUNTIME.name);
  const badge = row.getByRole("link", {
    name: `Runtime: ${TEAM_RUNTIME.name}, open its settings`,
  });
  await expect(badge).toBeVisible();
  // An image none of the runtimes runs is named as that.
  await expect(
    agentsPage.rowFor(ON_OWN_IMAGE.name).getByRole("link", {
      name: "Runtime: Custom image, open runtime settings",
    }),
  ).toBeVisible();

  // The long name is cut inside the badge, with all of it in the tooltip.
  const shown = badge.locator("span").last();
  expect(
    await shown.evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true);
  await badge.hover();
  await expect(
    page.getByRole("tooltip").getByText(TEAM_RUNTIME.name),
  ).toBeVisible();

  // The badge sits on the name's own line, inside the name's cell: it did
  // not wrap out of sight, and it is not cut by the next column.
  const box = async (locator: typeof badge) => {
    const bounds = await locator.boundingBox();
    if (!bounds) throw new Error("not laid out");
    return bounds;
  };
  const badgeBox = await box(badge);
  const nameBox = await box(
    row.getByRole("link", { name: ON_TEAM_RUNTIME.name, exact: true }),
  );
  const cellBox = await box(row.getByRole("cell").nth(1));
  expect(
    Math.abs(
      badgeBox.y + badgeBox.height / 2 - (nameBox.y + nameBox.height / 2),
    ),
  ).toBeLessThan(4);
  expect(badgeBox.x).toBeGreaterThan(nameBox.x + nameBox.width);
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(
    cellBox.x + cellBox.width,
  );

  // The row stays one line tall, as a row with no runtime, and its actions
  // stay where they are.
  const height = async (name: string) =>
    (await box(agentsPage.rowFor(name))).height;
  expect(
    Math.abs(
      (await height(ON_TEAM_RUNTIME.name)) -
        (await height(WITHOUT_RUNTIME.name)),
    ),
  ).toBeLessThan(2);
  await expect(
    row.getByRole("button", { name: /more actions/i }),
  ).toBeInViewport({ ratio: 1 });

  // The badge leads to that runtime's editor, not to the agent's page.
  await badge.click();
  await expect(page).toHaveURL(
    new RegExp(`/settings/agents/runtimes\\?edit=${TEAM_RUNTIME.id}$`),
  );
  await expect(
    page.getByRole("dialog", { name: `Edit ${TEAM_RUNTIME.name}` }),
  ).toBeVisible();
});

test("someone who cannot open the runtime settings keeps the plain runtime mark in the table", async ({
  request,
  agentsPage,
  mswControl,
}) => {
  await runtimeAgents({ request, mswControl });
  await mswControl.use({
    method: "get",
    url: "/api/user/permissions",
    body: makeUserPermissions({ organizationSettings: [] }),
  });
  await agentsPage.goto();

  const row = agentsPage.rowFor(ON_TEAM_RUNTIME.name);
  await expect(row.getByText("Runtime", { exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: /^Runtime: / })).toHaveCount(0);
  await expect(row.getByText(TEAM_RUNTIME.name)).toHaveCount(0);
});

/** Agent Runtime on, with agents on a custom runtime and on their own image. */
async function runtimeAgents({
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
        features: { ...config.features, agentRuntime: true },
      },
    },
    // Agent Runtime on: the sidebar lists runs.
    {
      method: "get",
      url: "/api/agent-runs",
      body: { data: [], pagination: {} },
    },
    {
      method: "get",
      url: "/api/agent-runtime-templates",
      body: [TEAM_RUNTIME],
    },
    // The runtime's editor: its settings, and no agents on older ones.
    {
      method: "get",
      url: "/api/agent-runtime-templates/settings",
      body: {
        revision: 1,
        templates: [
          {
            id: TEAM_RUNTIME.id,
            name: TEAM_RUNTIME.name,
            description: "",
            icon: null,
            hidden: false,
            position: 0,
            runtime: TEAM_RUNTIME_SETTINGS,
          },
        ],
        builtIns: {},
        popularAgentOverrides: makeOrganization().popularAgentOverrides,
      },
    },
    {
      method: "get",
      url: "/api/agent-runtime-templates/:id/apply-to-agents",
      body: { agents: 0 },
    },
    {
      method: "get",
      url: "/api/agent-catalog",
      query: { pinned: "false" },
      body: makeAgentCatalog({
        agents: [ON_TEAM_RUNTIME, ON_OWN_IMAGE, WITHOUT_RUNTIME],
      }),
    },
    {
      method: "get",
      url: "/api/agent-catalog",
      query: { pinned: "true" },
      body: makeAgentCatalog(),
    },
  ]);
}
