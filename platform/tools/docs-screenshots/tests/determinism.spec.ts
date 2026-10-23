import { expect, test } from "@playwright/test";
import { normalizeIdentifiers, waitForAppReady } from "../src/determinism";

test("independent fixture identities render identically without hiding other changes", async ({
  browser,
}) => {
  const captures: Buffer[] = [];
  for (const [index, id] of [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ].entries()) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const token = `arch_${index ? "b".repeat(64) : "a".repeat(64)}`;
    const masked = `arch_${index ? "b".repeat(8) : "a".repeat(8)}***`;
    const unrelated = "33333333-3333-4333-8333-333333333333";
    await page.setContent(`<a href="/agents/${id}">/v2/a2a/${id}</a>
      <pre>Bearer ${token}\n${masked}\n${unrelated}</pre>
      <input value="${token}"/><p>Real product copy</p>`);
    await normalizeIdentifiers(page, { agents: { "Support Triage": id } });
    await expect(page.getByRole("link")).toHaveAttribute(
      "href",
      `/agents/${id}`,
    );
    await expect(page.getByText(unrelated, { exact: false })).toContainText(
      unrelated,
    );
    await expect(page.getByRole("textbox")).toHaveValue(
      `arch_00000001${"0123456789abcdef".repeat(4).slice(0, 56)}`,
    );
    captures.push(await page.screenshot());
    if (index === 1) {
      await page.getByText("Real product copy").evaluate((element) => {
        element.textContent = "Changed product copy";
      });
      await normalizeIdentifiers(page, { agents: { "Support Triage": id } });
      expect(await page.screenshot()).not.toEqual(captures[0]);
    }
    await context.close();
  }
  expect(captures[1]).toEqual(captures[0]);
});

test("credential format and masking regressions remain visible", async ({
  page,
}) => {
  const token = `arch_${"a".repeat(64)}`;
  await page.setContent(`<input value="${token}"/><pre>arch_aaaaaaaa***</pre>`);
  await normalizeIdentifiers(page, {});
  await expect(page.getByText("arch_00000001***")).toBeVisible();
  const baseline = await page.screenshot();
  const invalid = `ARCH_${"A".repeat(64)}`;
  await page.getByRole("textbox").fill(invalid);
  await normalizeIdentifiers(page, {});
  await expect(page.getByRole("textbox")).toHaveValue(invalid);
  expect(await page.screenshot()).not.toEqual(baseline);
  await page.getByRole("textbox").fill(token);
  await page.getByText("arch_00000001***").evaluate((element) => {
    element.textContent = "arch_00000001";
  });
  await normalizeIdentifiers(page, {});
  expect(await page.screenshot()).not.toEqual(baseline);
});

test("a mismatched key and code example remain different", async ({ page }) => {
  await page.setContent(
    `<input value="arch_${"a".repeat(64)}"/><pre>Bearer arch_${"b".repeat(64)}</pre>`,
  );
  await normalizeIdentifiers(page, {});
  const value = await page.getByRole("textbox").inputValue();
  expect(await page.locator("pre").textContent()).not.toBe(`Bearer ${value}`);
});

test("capture waits for app readiness instead of freezing a loading frame", async ({
  page,
}) => {
  await page.setContent(
    `<output aria-live="polite"><span>Loading…</span></output>`,
  );
  await page.evaluate(() => {
    setTimeout(() => {
      const output = document.querySelector("output");
      if (output) output.textContent = "";
    }, 150);
  });
  await waitForAppReady(page);
  await expect(page.getByRole("status")).toBeEmpty();
});
