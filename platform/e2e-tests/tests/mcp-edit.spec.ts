import { expect } from "@playwright/test";
import { getE2eRequestUrl, UI_BASE_URL } from "../consts";
import { goToPage, type Page, test } from "../fixtures";
import { closeOpenDialogs } from "../utils";

/**
 * Saving a catalog edit can restart the servers running it, and the form warns
 * about that with an inline confirm bar. Which bar appears comes from
 * `computeCascadeOutcome`, a frontend mirror of the backend gate that decides
 * what the save actually does — two implementations of one rule, which can
 * disagree without either side erroring.
 *
 * A live install is the only place they are observed together, so that is what
 * these pin. Tenancy is the sole difference between the two cases and their
 * expectations are opposites, so a mirror that stops distinguishing it fails
 * one of them whichever way it drifts.
 *
 * Scope is the bar itself, not what the save then does. The backend half is
 * already pinned deterministically and without a cluster by
 * `backend/src/routes/internal-mcp-catalog.multitenant-rollout.test.ts`.
 *
 * The multi-tenant case therefore cancels rather than confirms. Confirming
 * starts a background shared-pod recreate; cleanup then deletes the install,
 * the recreate puts the deployment back, and it is orphaned — the row that
 * owned it is gone, so nothing reaps it. Every run leaked one, and enough of
 * them saturate the cluster. Cancelling asserts the same decision and leaves
 * nothing behind. Single-tenant confirms safely: its path writes its flags
 * inside the request and starts no background work.
 */

const BASE_IMAGE = "alpine:3.20";
// Real published tags. An invented one (`alpine:3.20-e2e-1`) leaves the shared
// deployment wedged in ImagePullBackOff long after the test, and enough of
// those saturate the cluster the next run needs.
const BUMP_TAGS = ["alpine:3.21", "alpine:3.19", "alpine:3.18"];

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
 * A catalog item plus one install, which is all the save gate reads. The
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
    description: "e2e confirm bar fixture",
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

/** Uninstall first, then delete the catalog — the install owns the deployment,
 *  and a catalog delete alone leaves it running. Failures are reported rather
 *  than swallowed: silent cleanup leaks accumulate into a cluster that fails
 *  the next run for unrelated-looking reasons. */
async function destroyFixture(page: Page, fixture: InstalledFixture | null) {
  if (!fixture) return;
  for (const suffix of [
    `/api/mcp_server/${fixture.serverId}`,
    `/api/internal_mcp_catalog/${fixture.catalogId}`,
  ]) {
    const response = await page.request
      .delete(getE2eRequestUrl(suffix), { headers: { Origin: UI_BASE_URL } })
      .catch((error: Error) => error);
    if (response instanceof Error) {
      console.warn(`cleanup DELETE ${suffix} threw: ${response.message}`);
    } else if (!response.ok()) {
      console.warn(`cleanup DELETE ${suffix} -> ${response.status()}`);
    }
  }
}

/**
 * Bump the image tag on the catalog's edit route until the confirm bar
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
    await imageInput.fill(BUMP_TAGS[(attempt - 1) % BUMP_TAGS.length]);

    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText(barText)).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 120_000, intervals: [500] });
}

async function readInstall(page: Page, serverId: string) {
  return apiJson(page, "get", `/api/mcp_server/${serverId}`);
}

test.describe("MCP catalog edit — reinstall confirm bar", () => {
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
      makeRandomString(8, "mt-edit"),
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

    // Dismiss rather than commit — see the file docstring.
    await adminPage.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden({ timeout: 30_000 });
  });

  test("single-tenant image bump still defers to a per-install reinstall", async ({
    adminPage,
    makeRandomString,
  }) => {
    fixture = await createCatalogWithInstall(
      adminPage,
      makeRandomString(8, "st-edit"),
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

    // "restart" is the reason that reuses the stored secret bag; "new-input" is
    // the one that makes the reinstall dialog collect values. Polled rather
    // than read once: the bar disappearing proves the mutation resolved, not
    // that this read observes the row it wrote.
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
