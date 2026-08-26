import type { APIRequestContext } from "@playwright/test";
import { makeCatalogItem } from "@/mocks/data/catalog";
import { makeInstalledServer } from "@/mocks/data/servers";
import { expect, test } from "./fixtures";
import type { MswControl } from "./helpers/msw-control";

/**
 * The sidebar's "needs attention" count is the one filled numeric badge in the
 * navigation, and it rides on `SidebarMenuAction` — shadcn's slot for square
 * icon buttons. Inheriting that slot's `rounded-md`/`aspect-square` gave it two
 * defects a class-name assertion would not have described: it read as a
 * rounded square next to circular counts everywhere else, and because a square
 * aspect derives height from width, a wider number made the badge taller than
 * the row it sits in.
 *
 * So these assert geometry, not classes. A circle is "as wide as it is tall,
 * with a radius of at least half that"; the three-digit case pins the height to
 * the row rhythm while the badge grows sideways into a pill.
 */

const CATALOG_ID = "cat-broken";

function brokenServer(index: number) {
  return makeInstalledServer({
    id: `srv-broken-${index}`,
    name: `broken-${index}`,
    catalogId: `${CATALOG_ID}-${index}`,
    localInstallationStatus: "error",
    localInstallationError: "Container image could not be pulled.",
    // The seeded server carries an OAuth refresh failure; a second issue kind
    // would not change the count, but keeping it out makes the fixture say
    // exactly what it means.
    oauthRefreshError: undefined,
    oauthRefreshErrorMessage: null,
    oauthRefreshErrorDescription: null,
    oauthRefreshFailedAt: null,
  });
}

/**
 * `count` catalog items, each with one install that failed to start, with the
 * alerting flag on so the badge has something to count.
 *
 * The config override is patched onto the seed fetched from the mock backend
 * rather than rebuilt with `makeConfig`: that factory imports runtime values
 * from `@archestra/shared`, whose barrel pulls in a JSON module the Playwright
 * loader will not take.
 */
async function seedServersNeedingAttention(
  {
    mswControl,
    request,
  }: { mswControl: MswControl; request: APIRequestContext },
  count: number,
) {
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  await mswControl.use({
    method: "get",
    url: "/api/config",
    body: {
      ...config,
      features: { ...config.features, mcpServerAlertingEnabled: true },
    },
  });
  await mswControl.use({
    method: "get",
    url: "/api/internal_mcp_catalog",
    body: Array.from({ length: count }, (_, i) =>
      makeCatalogItem({
        id: `${CATALOG_ID}-${i}`,
        name: `broken-${i}`,
        serverType: "local",
      }),
    ),
  });
  await mswControl.use({
    method: "get",
    url: "/api/mcp_server",
    body: Array.from({ length: count }, (_, i) => brokenServer(i)),
  });
}

test.describe("sidebar attention badge", () => {
  test("renders a circle for a single-digit count", async ({
    page,
    mswControl,
    request,
  }) => {
    await seedServersNeedingAttention({ mswControl, request }, 3);
    await page.goto("/mcp/registry");

    const badge = page.getByTestId("sidebar-mcp-registry-attention-count");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/^3/);

    const box = await badge.boundingBox();
    if (!box) throw new Error("attention badge has no bounding box");
    expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);

    const radius = await badge.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).borderTopLeftRadius),
    );
    expect(radius).toBeGreaterThanOrEqual(box.height / 2);
  });

  test("stays row-height and turns into a pill for a three-digit count", async ({
    page,
    mswControl,
    request,
  }) => {
    await seedServersNeedingAttention({ mswControl, request }, 128);
    await page.goto("/mcp/registry");

    const badge = page.getByTestId("sidebar-mcp-registry-attention-count");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/^128/);

    const box = await badge.boundingBox();
    if (!box) throw new Error("attention badge has no bounding box");
    // 20px — the height every other sidebar count uses. A square aspect would
    // have grown this to match the wider number.
    expect(box.height).toBeCloseTo(20, 0);
    expect(box.width).toBeGreaterThan(box.height);

    const radius = await badge.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).borderTopLeftRadius),
    );
    expect(radius).toBeGreaterThanOrEqual(box.height / 2);
  });
});
