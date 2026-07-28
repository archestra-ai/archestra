import { expect } from "@playwright/test";
import { getE2eRequestUrl, UI_BASE_URL } from "../consts";
import { goToPage, type Page, test } from "../fixtures";
import { closeOpenDialogs } from "../utils";

/**
 * The catalog edit form decides which confirm bar to show from
 * `computeCascadeOutcome`, a frontend mirror of the backend cascade gate. The
 * two have drifted before: after the backend stopped treating execution-config
 * drift on a multi-tenant catalog as needing user input, the mirror kept
 * classifying it as "manual", so bumping a docker image told admins the change
 * "needs a new value" and parked the rollout behind a second click — for a
 * value no dialog ever collects.
 *
 * These specs pin the bar against a live install, which is the one place the
 * two layers are observed together. Tenancy is the only difference between the
 * first two cases, so they fail in opposite directions if the mirror regresses.
 *
 * Deliberately no wait on pod health: what's under test is the cascade
 * decision, which the route makes from the catalog row and the existence of an
 * install. Tying these to a pod coming up would import that flakiness for no
 * added assertion.
 */

const BASE_IMAGE = "alpine:3.20";

type InstalledFixture = { catalogId: string; serverId: string; name: string };

async function apiJson(
  page: Page,
  method: "post" | "get" | "delete",
  suffix: string,
  data?: unknown,
) {
  const response = await page.request[method](getE2eRequestUrl(suffix), {
    headers: { Origin: UI_BASE_URL },
    ...(data === undefined ? {} : { data }),
  });
  if (!response.ok()) {
    throw new Error(
      `${method.toUpperCase()} ${suffix} -> ${response.status()} ${await response.text()}`,
    );
  }
  return response.json();
}

/**
 * A catalog item plus one install, which is all the cascade gate reads. The
 * install is not waited on: `affectedServerCount > 0` is what makes the form
 * offer a confirm bar, and that holds the moment the row exists.
 */
async function createCatalogWithInstall(
  page: Page,
  name: string,
  multitenant: boolean,
): Promise<InstalledFixture> {
  const catalog = await apiJson(page, "post", "/api/internal_mcp_catalog", {
    name,
    description: "e2e cascade bar fixture",
    serverType: "local",
    multitenant,
    localConfig: {
      command: "sleep",
      arguments: ["3600"],
      dockerImage: BASE_IMAGE,
      environment: [],
    },
  });
  const server = await apiJson(page, "post", "/api/mcp_server", {
    name,
    catalogId: catalog.id,
  });
  return { catalogId: catalog.id, serverId: server.id, name };
}

async function destroyFixture(page: Page, fixture: InstalledFixture | null) {
  if (!fixture) return;
  await page.request
    .delete(getE2eRequestUrl(`/api/mcp_server/${fixture.serverId}`), {
      headers: { Origin: UI_BASE_URL },
    })
    .catch(() => undefined);
  await page.request
    .delete(
      getE2eRequestUrl(`/api/internal_mcp_catalog/${fixture.catalogId}`),
      {
        headers: { Origin: UI_BASE_URL },
      },
    )
    .catch(() => undefined);
}

/**
 * Bump the image tag on the catalog's edit route until the cascade confirm bar
 * is on screen, then leave it there for the caller to assert against.
 *
 * Deep-linking rather than driving the registry card: that path adds a search
 * filter, a card whose position depends on whatever else the dev database
 * holds, and a navigation click, none of which this spec is testing.
 *
 * Retried rather than gated on a readiness signal, because no reliable one
 * exists. The bar is only offered when `affectedServerCount > 0`, which comes
 * from an installs query that is itself gated on a permissions query
 * (`enabled: … && !!canReadInstallations` in `mcp-server.query.ts`) and reads
 * `[]` until both resolve. So a slow permissions round-trip makes the form
 * treat the catalog as having no installs and save outright, with no request
 * to wait on and nothing rendered to poll. Each attempt writes a fresh tag, so
 * a save that slipped through simply becomes the next attempt's starting
 * point — the edit stays a real execution-config change either way.
 */
async function bumpImageUntilConfirmBar(
  page: Page,
  catalogId: string,
  barText: string,
): Promise<void> {
  let attempt = 0;
  await expect(async () => {
    attempt += 1;
    await goToPage(page, `/mcp/registry/${catalogId}/edit`);
    await page.waitForLoadState("domcontentloaded");

    const imageInput = page.getByRole("textbox", { name: "Image (optional)" });
    // The catalog query has resolved once it has populated this field.
    await expect(imageInput).toHaveValue(/^alpine:/, { timeout: 60_000 });
    await imageInput.fill(`${BASE_IMAGE}-e2e-${attempt}`);

    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText(barText)).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 120_000, intervals: [500] });
}

async function readInstall(page: Page, serverId: string) {
  return apiJson(page, "get", `/api/mcp_server/${serverId}`);
}

test.describe("MCP catalog edit — multi-tenant cascade confirm bar", () => {
  test.describe.configure({ timeout: 240_000 });

  let fixture: InstalledFixture | null = null;

  test.afterEach(async ({ adminPage }) => {
    await closeOpenDialogs(adminPage, { timeoutMs: 10_000 }).catch(
      () => undefined,
    );
    await destroyFixture(adminPage, fixture);
    fixture = null;
  });

  test("multi-tenant image bump offers an immediate restart, not a deferred reinstall", async ({
    adminPage,
    makeRandomString,
  }) => {
    fixture = await createCatalogWithInstall(
      adminPage,
      makeRandomString(8, "mt-cascade"),
      true,
    );

    // One shared pod, owned by the admin doing the edit, and no tenant owes a
    // value — so the bar offers to roll it now.
    await bumpImageUntilConfirmBar(
      adminPage,
      fixture.catalogId,
      "Restart the shared deployment now?",
    );
    const confirm = adminPage.getByRole("button", { name: "Save and restart" });
    await expect(confirm).toBeVisible();

    // The regression this guards: the deferred bar and its claim that the
    // admin must supply a value.
    await expect(adminPage.getByText(/will need a Reinstall/)).toBeHidden();
    await expect(adminPage.getByText(/needs a new value/)).toBeHidden();

    await confirm.click();
    await expect(confirm).toBeHidden({ timeout: 60_000 });

    // Backend agreement. "new-input" is the reason that makes the reinstall
    // dialog collect credentials, and the auto path cannot produce it — a
    // failed recreate downgrades to "restart", never to owed input.
    const install = await readInstall(adminPage, fixture.serverId);
    expect(install.reinstallReason).not.toBe("new-input");
  });

  test("single-tenant image bump still defers to a per-install reinstall", async ({
    adminPage,
    makeRandomString,
  }) => {
    fixture = await createCatalogWithInstall(
      adminPage,
      makeRandomString(8, "st-cascade"),
      false,
    );

    // Each install owns its own pod here, so restarting everyone's on one
    // admin's save would surprise them — the rollout stays opt-in per install.
    await bumpImageUntilConfirmBar(
      adminPage,
      fixture.catalogId,
      "will need a Reinstall",
    );
    const confirm = adminPage.getByRole("button", { name: "Save change" });
    await expect(confirm).toBeVisible();
    await expect(
      adminPage.getByText("Restart the shared deployment now?"),
    ).toBeHidden();

    await confirm.click();
    await expect(confirm).toBeHidden({ timeout: 60_000 });

    // Flagged for an explicit restart, and stored credentials stay valid —
    // the route writes both fields before the response, so this is settled.
    await expect
      .poll(
        async () =>
          (await readInstall(adminPage, fixture?.serverId ?? "")) as {
            reinstallRequired: boolean;
            reinstallReason: string | null;
          },
        { timeout: 30_000 },
      )
      .toMatchObject({ reinstallRequired: true, reinstallReason: "restart" });
  });
});
