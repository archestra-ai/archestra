import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

// An installer opens the approval page with its request in the URL. Without
// a server seed (here the session lives in the browser's mocks, so the
// document renders unseeded) the page loads its data in the browser: it may
// check the connection settings first, but then reveals the card once, in
// its final layout, without "Nothing to connect" or a second loader on the
// way, and prepares exactly one setup. The seeded document is covered by the
// shell seed's unit tests.
const REQUEST_ID = "ab12".repeat(12);
const APPROVAL_PATH = `/connection?clientId=opencode&platform=linux&connectRequest=${REQUEST_ID}`;
// Interim panels that a moment later turn into the card. (The request's
// loading state keeps the card's layout; the shift check covers it.)
const LOADING_STATES = [
  "Nothing to connect",
  "No selected resource can be configured",
];

test.use({ viewport: { width: 1440, height: 900 } });

const GATEWAY = {
  id: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  name: "Team Gateway",
  slug: null,
  agentType: "mcp_gateway",
  icon: null,
  scope: "org",
  authorId: null,
  authorName: null,
  authorEmail: null,
  isPersonalGateway: false,
  runtime: null,
  description: "Shared gateway",
  teams: [],
  users: [],
};

test("a cold, unseeded load of the approval page reveals it once, in its final layout", async ({
  page,
  mswControl,
}) => {
  // One gateway to connect (the default, in the list and by id) and a key.
  await mswControl.registerMany([
    { method: "get", url: "/api/mcp-gateways/default", body: GATEWAY },
    // A usable primary provider key, so OpenCode routes its models.
    {
      method: "get",
      url: "/api/llm-provider-api-keys/available",
      body: [
        {
          ...makeLlmProviderApiKey({ bestModelId: null }),
          provider: "openai",
          isPrimary: true,
          baseUrl: null,
          requiresReauthentication: false,
        },
      ],
    },
    {
      method: "get",
      url: "/api/agents/options/page",
      body: {
        data: [GATEWAY],
        pagination: { limit: 20, nextCursor: null, hasNext: false },
      },
    },
    {
      method: "get",
      url: "/api/agents/options",
      body: {
        data: [GATEWAY],
        pagination: { limit: 100, nextCursor: null, hasNext: false },
      },
    },
  ]);
  // Record from the first frame: every loading text the page ever shows,
  // and every layout shift after first paint.
  await page.addInitScript((states: string[]) => {
    const w = window as unknown as {
      __seen: string[];
      __shift: number;
      __fcp: number | null;
    };
    w.__seen = [];
    w.__shift = 0;
    w.__fcp = null;
    const check = () => {
      const text = document.body?.innerText ?? "";
      for (const state of states) {
        if (text.includes(state) && !w.__seen.includes(state)) {
          w.__seen.push(state);
        }
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") w.__fcp = entry.startTime;
      }
    }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        startTime: number;
        value: number;
        sources?: { node?: Node | null }[];
      }[]) {
        // The page's own content: the unseeded shell around it fills in on
        // its own schedule.
        const inPage = (entry.sources ?? []).some((source) =>
          source.node
            ? !!document.querySelector("main")?.contains(source.node)
            : false,
        );
        if (inPage && w.__fcp !== null && entry.startTime >= w.__fcp) {
          w.__shift += entry.value;
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  }, LOADING_STATES);
  const browserReads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      browserReads.push(`${request.method()} ${url.pathname}`);
    }
  });

  await page.goto(APPROVAL_PATH);

  await expect(page.getByText("ABCD-1234")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Setup options/ }),
  ).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve connection" });
  await expect(approve).toBeVisible();
  await expect(page.getByTestId("approve-connection-progress")).toHaveCount(0);
  await page.getByRole("checkbox").click();
  await expect(approve).toBeEnabled();

  const recorded = await page.evaluate(() => {
    const w = window as unknown as { __seen: string[]; __shift: number };
    return { seen: w.__seen, shift: w.__shift };
  });
  expect(recorded.seen).toEqual([]);
  expect(recorded.shift).toBeLessThan(0.001);
  // One setup per load, and each part read once.
  const count = (entry: string) =>
    browserReads.filter((read) => read === entry).length;
  expect(count("POST /api/connection-setups")).toBe(1);
  expect(count(`GET /api/client-connections/${REQUEST_ID}`)).toBe(1);
  expect(count("GET /api/agents/options/page")).toBe(1);
  expect(count("GET /api/skills/names")).toBe(1);
});
