import { makeOrganization } from "../src/mocks/data/organization";
import { expect, test } from "./fixtures";

test("an administrator resizes a runtime tier: problems block Save, and only the filled fields are saved", async ({
  page,
  request,
  mswControl,
}, testInfo) => {
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  const organization = makeOrganization({
    agentRuntimeTiers: { L: { memoryLimit: "24Gi" } },
  });
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
  const cpu = page.getByLabel("Tier L CPU request");
  await expect(cpu).toHaveAttribute("placeholder", "8");
  await expect(page.getByLabel("Tier L Memory limit")).toHaveValue("24Gi");
  await expect(page.getByLabel("Tier M Warm spares")).toHaveAttribute(
    "placeholder",
    "Deployment",
  );

  await cpu.fill("1");
  await expect(
    page.getByRole("alert", { name: "Runtime tier problems" }),
  ).toContainText("Tier L requests less than tier M");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await heading.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("runtime-tiers-problem.png"),
    fullPage: false,
  });

  await cpu.fill("6");
  await page.getByLabel("Tier L Warm spares").fill("1");
  const saved = {
    L: { cpuRequest: "6", memoryLimit: "24Gi", warmPoolSize: 1 },
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
