import { makeOrganization } from "../src/mocks/data/organization";
import { expect, test } from "./fixtures";

test("an administrator resizes a runtime tier: memory follows the CPU, a problem blocks Save, and the whole list is saved", async ({
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

  const heading = page.getByRole("heading", { name: "Runtime tiers" });
  await heading.scrollIntoViewIfNeeded();
  // The tiers in effect, smallest first, each with the memory its CPU gives it.
  const cpu = page.getByLabel("Tier L CPU request");
  await expect(cpu).toHaveValue("8");
  await expect(page.getByLabel("Tier L CPU limit")).toHaveAttribute(
    "placeholder",
    "No limit",
  );
  const row = page.getByRole("row").filter({ has: cpu });
  await expect(row).toContainText("16 GiB");
  await expect(row).toContainText("32 GiB limit");
  await expect(page.getByLabel("Default tier M")).toBeChecked();

  // A value out of range is named, and Save stays disabled.
  await cpu.fill("9");
  await expect(
    page.getByRole("alert", { name: "Runtime tier problems" }),
  ).toContainText("Tier L: the CPU request is more than 0 and at most 8");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await heading.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("runtime-tiers-problem.png"),
    fullPage: false,
  });

  // A valid size: the memory follows while typing, and the save sends the
  // whole list with the default tier.
  await cpu.fill("6");
  await expect(row).toContainText("12 GiB");
  await expect(row).toContainText("24 GiB limit");
  await page.getByLabel("Tier L ready spares").fill("1");
  const saved = {
    tiers: [
      { name: "S", cpuRequest: 2, cpuLimit: null, warmSpares: 1 },
      { name: "M", cpuRequest: 4, cpuLimit: null, warmSpares: 1 },
      { name: "L", cpuRequest: 6, cpuLimit: null, warmSpares: 1 },
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
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await save).postDataJSON()).toEqual({ agentRuntimeTiers: saved });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await heading.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`runtime-tiers-${width}.png`),
    });
  }
});
