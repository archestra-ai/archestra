import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";

// Real browser layout: the three Agent connections cards stay short and level
// in a row on desktop, and on a tablet the calls card takes its own full-width
// row instead of leaving a tall, half-empty third column.
const now = new Date().toISOString();

test.describe("Agent connections cards", () => {
  test.beforeEach(async ({ mswControl }) => {
    await mswControl.use({
      method: "get",
      url: "/api/connected-clients/adoption",
      body: { since: now, until: now, members: MEMBERS },
    });
    await mswControl.use({
      method: "get",
      url: "/api/connected-clients/adoption/usage",
      body: { since: now, until: now, days: DAYS },
    });
    await mswControl.use({
      method: "get",
      url: "/api/connected-clients/log",
      body: {
        data: [],
        pagination: { limit: 50, nextCursor: null, hasNext: false },
      },
    });
  });

  test("sit level in one row on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const [users, agents, calls] = await cardBoxes(page);

    for (const card of [agents, calls]) {
      expect(Math.abs(card.y - users.y)).toBeLessThan(2);
      expect(Math.abs(card.height - users.height)).toBeLessThan(2);
    }
    expect(agents.x).toBeGreaterThan(users.x + users.width);
    expect(calls.x).toBeGreaterThan(agents.x + agents.width);
  });

  test("give agent calls its own full-width row on a tablet", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 1000 });
    const [users, agents, calls] = await cardBoxes(page);

    expect(Math.abs(agents.y - users.y)).toBeLessThan(2);
    expect(calls.y).toBeGreaterThan(users.y + users.height);
    expect(Math.abs(calls.x - users.x)).toBeLessThan(2);
    expect(
      Math.abs(calls.x + calls.width - (agents.x + agents.width)),
    ).toBeLessThan(2);
  });

  test("stack in one column on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const [users, agents, calls] = await cardBoxes(page);

    expect(agents.y).toBeGreaterThan(users.y + users.height);
    expect(calls.y).toBeGreaterThan(agents.y + agents.height);
    for (const card of [users, agents, calls]) {
      expect(card.x + card.width).toBeLessThanOrEqual(390);
    }
  });
});

async function cardBoxes(page: Page) {
  await page.goto("/connections/logs");
  const titles = [
    /^Active users in the last/,
    /^Most used agents in the last/,
    /^Agent calls in the/,
  ];
  const boxes = [];
  for (const title of titles) {
    const card = page
      .locator("[data-slot=card]")
      .filter({ has: page.getByText(title) });
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    if (!box) throw new Error(`Card not rendered: ${title}`);
    boxes.push(box);
  }
  return boxes;
}

const AGENTS = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["copilot-cli", "Copilot CLI"],
];

const MEMBERS = [
  ...[[0, 1], [0, 2], [0]].map((picks, i) => ({
    userId: `u-active-${i}`,
    name: `Active user ${i}`,
    email: `active${i}@example.com`,
    status: "active",
    gatewayLastSeenAt: now,
    llmLastSeenAt: now,
    agents: picks.map((pick) => ({
      clientId: AGENTS[pick][0],
      name: AGENTS[pick][1],
      status: "active",
      setupAt: now,
      signedIn: false,
      viaToken: false,
      lastGatewayCallAt: now,
      lastLlmCallAt: now,
    })),
    gatewayUses: [],
    llmUses: [],
  })),
  {
    userId: "u-new",
    name: "New user",
    email: "new@example.com",
    status: "notConnected",
    gatewayLastSeenAt: null,
    llmLastSeenAt: null,
    agents: [],
    gatewayUses: [],
    llmUses: [],
  },
];

const DAYS = Array.from({ length: 30 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 8, 14 + i)).toISOString().slice(0, 10),
  gatewayCalls: 10 + (i % 7) * 5,
  llmCalls: 60 + (i % 5) * 20,
}));
