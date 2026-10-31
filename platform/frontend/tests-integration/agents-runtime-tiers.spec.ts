import { makeOrganization } from "../src/mocks/data/organization";
import { expect, test } from "./fixtures";

test("an administrator edits a runtime tier in its dialog: a bad CPU request is named under the field, memory follows, and the whole list is saved", async ({
  page,
  request,
  mswControl,
}, testInfo) => {
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  const organization = makeOrganization();
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
    { method: "get", url: "/api/organization", body: organization },
    // Agent Runtime on: the sidebar lists runs.
    {
      method: "get",
      url: "/api/agent-runs",
      body: { data: [], pagination: {} },
    },
  ]);
  await page.goto("/settings/agents");

  const block = page.locator("#runtime-tiers");
  const heading = block.getByRole("heading", { name: "Runtime tiers" });
  await heading.scrollIntoViewIfNeeded();
  await expect(block).toContainText(
    "Runtime tiers control compute and other resources allocation to agent runtimes.",
  );
  await expect(block.getByRole("link", { name: /Learn more/ })).toHaveAttribute(
    "href",
    /\/docs\/agents\/runtime\/setup#runtime-tiers$/,
  );
  await expect(block.getByPlaceholder("Search tiers")).toHaveCount(0);
  // The Pools header explains itself, so nobody opens a form to read it.
  await block.getByRole("button", { name: "About pooled tiers" }).hover();
  const hint = page.getByRole("dialog", { name: "About pooled tiers" });
  await expect(hint).toContainText(
    "Agent runs start much quicker from pool of runtime instances. Managed automatically. Pooled instances reserve part of cluster's capacity.",
  );
  await expect(hint.getByRole("link", { name: /Learn more/ })).toHaveAttribute(
    "href",
    /\/docs\/agents\/runtime\/setup#warm-pools$/,
  );
  await page.screenshot({
    path: testInfo.outputPath("runtime-tiers-pools-hint.png"),
  });
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  // The tiers in effect, smallest first: memory, pools and the default.
  const rowOf = (name: string) =>
    block
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: `Edit ${name}` }) });
  await expect(rowOf("M")).toContainText("Default");
  await expect(rowOf("L")).toContainText("No limit");
  await expect(rowOf("L")).toContainText("16 GiB");
  await expect(rowOf("L")).toContainText("32 GiB limit");
  await expect(rowOf("L")).toContainText("20 GiB");
  await expect(rowOf("S")).toContainText("Pooled");
  await expect(
    block.getByRole("button", { name: "Create tier" }),
  ).toBeVisible();

  // Edit L: a value out of range is named under its field and blocks the save.
  await page.getByRole("button", { name: "Edit L" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit tier" });
  const cpu = dialog.getByLabel("CPU request");
  await expect(cpu).toHaveValue("8");
  await expect(dialog.getByLabel("Name")).toHaveAttribute("placeholder", "XL");
  await expect(cpu).toHaveAttribute("placeholder", "4");
  await expect(dialog.getByLabel("CPU limit")).toHaveAttribute(
    "placeholder",
    "No limit",
  );
  await expect(dialog.getByLabel("Workspace (GiB)")).toHaveAttribute(
    "placeholder",
    "20",
  );
  await cpu.fill("9");
  await dialog.getByLabel("Name").focus();
  await expect(dialog).toContainText("Enter a number from 0.1 to 8");
  await dialog.screenshot({
    path: testInfo.outputPath("runtime-tier-dialog-problem.png"),
  });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeVisible();

  // A valid size: the memory follows while typing; the save sends the whole
  // list with the default tier.
  await cpu.fill("6");
  await expect(dialog.getByTestId("tier-memory")).toHaveText(
    "Memory: 12 GiB, 24 GiB limit",
  );
  // The Pooled switch explains itself on request, from the keyboard too: the
  // hint's link is in the Tab order and Escape hands focus back to the icon.
  const about = dialog.getByRole("button", { name: "About pooled tiers" });
  await about.hover();
  await expect(hint).toContainText(
    "Agent runs start much quicker from pool of runtime instances.",
  );
  await about.focus();
  await page.keyboard.press("Enter");
  await expect(hint).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(hint.getByRole("link", { name: /Learn more/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  await expect(about).toBeFocused();
  await dialog.getByRole("switch", { name: "Pooled" }).click();
  await dialog.getByLabel("Workspace (GiB)").fill("60");
  const saved = {
    tiers: [
      {
        name: "S",
        cpuRequest: 2,
        cpuLimit: null,
        pooled: true,
        workspaceGiB: null,
      },
      {
        name: "M",
        cpuRequest: 4,
        cpuLimit: null,
        pooled: true,
        workspaceGiB: null,
      },
      {
        name: "L",
        cpuRequest: 6,
        cpuLimit: null,
        pooled: true,
        workspaceGiB: 60,
      },
    ],
    defaultTier: "M",
  };
  await mswControl.use({
    method: "patch",
    url: "/api/organization/agent-settings",
    body: { ...organization, agentRuntimeTiers: saved },
  });
  const save = page.waitForRequest(
    (r) =>
      r.method() === "PATCH" &&
      r.url().endsWith("/api/organization/agent-settings"),
  );
  await dialog.getByRole("button", { name: "Save changes" }).click();
  expect((await save).postDataJSON()).toEqual({ agentRuntimeTiers: saved });
  await expect(dialog).toBeHidden();

  // The table fits its column at every width: the table element is never
  // wider than the container that would otherwise scroll it sideways.
  const container = block.locator('[data-slot="table-container"]');
  const overflow: Record<number, number> = {};
  for (const width of [1440, 1180, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await heading.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`runtime-tiers-${width}.png`),
    });
    overflow[width] = await container.evaluate((element) => {
      const table = element.querySelector("table");
      if (!table) return Number.NaN;
      return Math.max(
        Math.ceil(table.getBoundingClientRect().width) - element.clientWidth,
        element.scrollWidth - element.clientWidth,
        0,
      );
    });
    // Laptop widths and up show every column; narrower ones drop some.
    if (width >= 1180) {
      await expect(rowOf("L")).toContainText("No limit");
      await expect(rowOf("S")).toContainText("Pooled");
    }
  }
  expect(
    overflow,
    `sideways overflow by viewport width: ${JSON.stringify(overflow)}`,
  ).toEqual({ 390: 0, 768: 0, 1024: 0, 1180: 0, 1440: 0 });
});
