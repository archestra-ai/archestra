import { E2eTestId } from "@archestra/shared";
import { type Locator, mergeTests, type Page } from "@playwright/test";
import { expect, test as uiTest } from "../fixtures";
import { test as apiTest } from "./api-fixtures";

const test = mergeTests(uiTest, apiTest);

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 640 },
  { width: 320, height: 568 },
]) {
  for (const family of [
    { path: "/mcp/gateways", title: "MCP Gateway" },
    { path: "/agents", title: "Agent" },
  ]) {
    test(`keeps ${family.title} create and edit actions consistent and reachable at ${viewport.width}px`, async ({
      page,
      request,
      deleteAgent,
      goToPage,
      makeRandomString,
    }) => {
      const name = makeRandomString(
        8,
        "Support workflow with tools and knowledge",
      );
      let createdId: string | undefined;
      let createRequests = 0;
      page.on("request", (request) => {
        if (
          new URL(request.url()).pathname === "/api/agents" &&
          request.method() === "POST"
        ) {
          createRequests++;
        }
      });

      await page.setViewportSize(viewport);
      await goToPage(page, `${family.path}/new`);
      const fromScratch = page.getByRole("button", {
        name: /start from scratch/i,
      });
      const nameField = page.getByRole("textbox", { name: /^Name\b/ });
      await expect(nameField.or(fromScratch)).toBeVisible();
      await expect(async () => {
        if (!(await nameField.isVisible())) await fromScratch.click();
        await expect(nameField).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });

      const next = page.getByTestId(E2eTestId.AgentSetupNextButton);
      const submit = page.getByTestId(E2eTestId.AgentSetupSubmitButton);
      const scrollContainer =
        viewport.width < 768
          ? page.getByRole("main")
          : page.locator("[data-page-scroll-container]");

      try {
        await expect(next).toBeDisabled();
        await expect(next).toBeInViewport({ ratio: 1 });
        // An enabled Next after filling proves React registered the value,
        // rather than just the browser updating a pre-hydration input.
        await expect(async () => {
          await nameField.fill(name);
          await expect(next).toBeEnabled({ timeout: 2_000 });
        }).toPass({ timeout: 20_000 });
        await goToStep({ page, button: next, step: "tools" });

        // The real tools panel is taller than the viewport in both flows.
        // No spacers or mocked content: catch an overflow ancestor trapping
        // the shared sticky footer outside the visible page.
        await expect(
          page.getByRole("button", { name: "Configuration", exact: true }),
        ).toBeVisible();
        await expect
          .poll(() =>
            scrollContainer.evaluate(
              (element) => element.scrollHeight - element.clientHeight,
            ),
          )
          .toBeGreaterThan(100);
        for (const fraction of [0, 0.5, 1]) {
          await scrollContainer.evaluate((element, fraction) => {
            element.scrollTop =
              (element.scrollHeight - element.clientHeight) * fraction;
          }, fraction);
          await expect(next).toBeInViewport({ ratio: 1 });
          await expect(
            page.getByRole("button", { name: "Configuration", exact: true }),
          ).toBeInViewport({ ratio: 1 });
        }
        expect(
          await scrollContainer.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);

        await goToStep({
          page,
          button: page.getByRole("button", {
            name: "Configuration",
            exact: true,
          }),
          step: "configuration",
        });
        await expect(nameField).toHaveValue(name);
        await goToStep({ page, button: next, step: "tools" });
        if (family.title === "Agent") {
          await goToStep({ page, button: next, step: "messaging" });
        }
        await goToStep({ page, button: next, step: "advanced" });
        await expect(submit).toBeEnabled();
        const createFooterStyle = await footerStyle(submit);
        expect(createRequests).toBe(0);

        // The final field stays reachable above the action row at the bottom.
        await scrollContainer.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect(page.getByLabel("Label key")).toBeInViewport({
          ratio: 1,
        });
        await expect(submit).toBeInViewport({ ratio: 1 });
        const labelBox = await page.getByLabel("Label key").boundingBox();
        const submitBox = await submit.boundingBox();
        expect(labelBox).not.toBeNull();
        expect(submitBox).not.toBeNull();
        if (labelBox && submitBox) {
          expect(labelBox.y + labelBox.height).toBeLessThan(submitBox.y);
        }
        await scrollContainer.evaluate((element) => {
          element.scrollTop = 0;
        });
        const responsePromise = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/agents" &&
            response.request().method() === "POST",
        );
        await expect(async () => {
          // Once dispatched, never click Create again while its response is
          // in flight. A dropped click can retry without creating duplicates.
          if (createRequests === 0) {
            await clickInViewport({ page, button: submit });
          }
          await expect.poll(() => createRequests, { timeout: 2_000 }).toBe(1);
        }).toPass({ timeout: 20_000 });
        const response = await responsePromise;
        expect(response.ok()).toBe(true);
        const created = await response.json();
        createdId = created.id;
        expect(created.name).toBe(name);
        expect(createRequests).toBe(1);
        await expect(page).toHaveURL(
          new RegExp(`${family.path}/${createdId}(\\?section=connect)?$`),
        );
        await expect(
          page.getByRole("heading", { name: "Endpoint", exact: true }),
        ).toBeVisible();

        const editPath = `${family.path}/${createdId}${
          family.title === "MCP Gateway" ? "?section=settings" : ""
        }`;
        await goToPage(page, editPath);
        await expect(nameField).toHaveValue(name);
        await expect(submit).toBeDisabled();
        expect(await footerStyle(submit)).toEqual(createFooterStyle);

        const updatedName = `${name} updated`;
        await expect(async () => {
          await nameField.fill(updatedName);
          await expect(submit).toBeEnabled({ timeout: 2_000 });
        }).toPass({ timeout: 20_000 });
        await expect
          .poll(() =>
            scrollContainer.evaluate(
              (element) => element.scrollHeight - element.clientHeight,
            ),
          )
          .toBeGreaterThan(100);
        for (const fraction of [0, 0.5, 1]) {
          await scrollContainer.evaluate((element, fraction) => {
            element.scrollTop =
              (element.scrollHeight - element.clientHeight) * fraction;
          }, fraction);
          await expect(submit).toBeInViewport({ ratio: 1 });
        }
        expect(
          await scrollContainer.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        await scrollContainer.evaluate((element) => {
          element.scrollTop = 0;
        });
        const saveResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `/api/agents/${createdId}` &&
            response.request().method() === "PUT",
        );
        await clickInViewport({ page, button: submit });
        expect((await saveResponse).ok()).toBe(true);
        await expect(submit).toBeDisabled();
        expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(
          editPath,
        );
        await page.reload();
        await expect(nameField).toHaveValue(updatedName);
        await expect(submit).toBeDisabled();
      } finally {
        if (createdId) await deleteAgent(request, createdId);
      }
    });
  }
}

async function footerStyle(button: Locator) {
  return button.evaluate((element) => {
    const footer = element.parentElement;
    if (!footer) throw new Error("Action footer is missing");
    const style = getComputedStyle(footer);
    return {
      background: style.backgroundColor,
      border: style.border,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      padding: style.padding,
      bottom: style.bottom,
    };
  });
}

async function goToStep({
  page,
  button,
  step,
}: {
  page: Page;
  button: Locator;
  step: "configuration" | "tools" | "messaging" | "advanced";
}) {
  const target = page.getByTestId(`${E2eTestId.AgentSetupStep}-${step}`);
  await expect(async () => {
    // Check the destination before retrying: Next is reused between steps,
    // so an unconditional retry could skip a successfully reached step.
    if ((await target.getAttribute("aria-current")) !== "step") {
      await clickInViewport({ page, button });
    }
    await expect(target).toHaveAttribute("aria-current", "step", {
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
}

async function clickInViewport({
  page,
  button,
}: {
  page: Page;
  button: Locator;
}) {
  await expect(button).toBeEnabled();
  await expect(button).toBeInViewport({ ratio: 1 });
  const box = await button.boundingBox();
  if (!box) throw new Error("Action is missing");
  // A locator click would silently scroll an off-screen action into view.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
