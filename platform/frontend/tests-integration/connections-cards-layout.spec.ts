import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";

const now = new Date().toISOString();

test.describe("Agent connections layout", () => {
  test.beforeEach(async ({ mswControl }) => {
    await mswControl.registerMany([
      {
        method: "get",
        url: "/api/connected-clients/adoption",
        body: { since: now, until: now, members: MEMBERS },
      },
      {
        method: "get",
        url: "/api/connected-clients/adoption/usage",
        body: { since: now, until: now, days: DAYS },
      },
      {
        method: "get",
        url: "/api/connected-clients/log",
        body: {
          data: [],
          pagination: { limit: 50, nextCursor: null, hasNext: false },
        },
      },
    ]);
  });

  for (const width of [1440, 820]) {
    test(`summary cards sit level at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      const [users, active, calls] = await cardBoxes(page);
      for (const card of [active, calls]) {
        expect(Math.abs(card.y - users.y)).toBeLessThan(2);
        expect(Math.abs(card.height - users.height)).toBeLessThan(2);
      }
      expect(active.x).toBeGreaterThan(users.x + users.width);
      expect(calls.x).toBeGreaterThan(active.x + active.width);
      expect(calls.x + calls.width).toBeLessThanOrEqual(width);
    });
  }

  test("summary cards stack without overflowing on a phone", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const [users, active, calls] = await cardBoxes(page);
    expect(active.y).toBeGreaterThan(users.y + users.height);
    expect(calls.y).toBeGreaterThan(active.y + active.height);
    for (const card of [users, active, calls])
      expect(card.x + card.width).toBeLessThanOrEqual(390);
  });

  test("expanded agents share the parent columns and centered identity", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/connections/logs?view=users");
    const table = page.getByRole("table");
    const parent = table
      .getByRole("row")
      .filter({ has: page.getByText("Active user 0", { exact: true }) });
    await parent
      .getByRole("button", { name: "Show Active user 0's agents" })
      .click();
    const child = table
      .getByRole("row")
      .filter({ has: page.getByText("Claude Code", { exact: true }) });
    await expect(child).toBeVisible();
    const parentCells = parent.getByRole("cell");
    const childCells = child.getByRole("cell");
    await expect(childCells).toHaveCount(await parentCells.count());
    const parentLefts = await parentCells.evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().left),
    );
    const childLefts = await childCells.evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().left),
    );
    expect(childLefts).toEqual(parentLefts);
    const identity = parentCells.nth(1);
    const avatar = await identity.locator("[data-slot=avatar]").boundingBox();
    const name = await identity
      .getByText("Active user 0", { exact: true })
      .boundingBox();
    const email = await identity
      .getByText("active0@example.com", { exact: true })
      .boundingBox();
    if (!avatar || !name || !email) throw new Error("User identity is missing");
    expect(
      Math.abs(
        avatar.y + avatar.height / 2 - (name.y + email.y + email.height) / 2,
      ),
    ).toBeLessThan(1);
    await identity.hover();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(identity.locator("[title]")).toHaveCount(0);
  });
});

async function cardBoxes(page: Page) {
  await page.goto("/connections/logs");
  const boxes = [];
  for (const title of ["Users", "Active users", "Calls"]) {
    const card = page
      .getByRole("button")
      .filter({ has: page.getByText(title, { exact: true }) });
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
