import { makeUserPermissions } from "../src/mocks/data/auth";
import { expect, test } from "./fixtures";

test.use({ hasTouch: true });

for (const input of ["wheel", "touch"] as const) {
  test(`scrolls a dialog's user picker with ${input} and retains search, pagination and selection`, async ({
    page,
    context,
    mswControl,
    request,
  }) => {
    const config = await (
      await request.get("/internal-test/api/api/config")
    ).json();
    const publicConfig = await (
      await request.get("/internal-test/api/api/config/public")
    ).json();
    const candidates = Array.from({ length: 45 }, (_, index) => ({
      id: `scroll-user-${index}`,
      name: `Scroll Person ${String(index).padStart(2, "0")}`,
      email: `scroll-person-${index}@example.com`,
      role: "member",
    }));
    const candidatePage = (offset: number) => ({
      data: candidates.slice(offset, offset + 20),
      pagination: {
        limit: 20,
        hasNext: offset + 20 < candidates.length,
        nextCursor:
          offset + 20 < candidates.length ? String(offset + 20) : null,
      },
    });
    await mswControl.registerMany([
      {
        method: "get",
        url: "/api/config",
        body: {
          ...config,
          enterpriseFeatures: { ...config.enterpriseFeatures, core: true },
        },
      },
      {
        method: "get",
        url: "/api/config/public",
        body: { ...publicConfig, enterpriseCoreActive: true },
      },
      {
        method: "get",
        url: "/api/user/permissions",
        body: makeUserPermissions({ member: ["read", "impersonate"] }),
      },
      {
        method: "get",
        url: "/api/user/impersonable",
        body: candidatePage(0),
      },
      ...[20, 40].map((offset) => ({
        method: "get" as const,
        url: "/api/user/impersonable",
        query: { cursor: String(offset) },
        body: candidatePage(offset),
      })),
      {
        method: "get",
        url: "/api/user/impersonable",
        query: { search: "Scroll Person 44" },
        body: {
          data: [candidates[44]],
          pagination: { limit: 20, hasNext: false, nextCursor: null },
        },
      },
    ]);
    await page.goto("/settings/roles");
    const opener = page.getByRole("button", { name: "Debug a role" });
    await opener.click();
    const picker = page.getByRole("combobox", { name: "Select a user" });
    await picker.click();
    const list = page.getByRole("listbox");
    await expect(list.getByRole("option")).toHaveCount(20);
    await expect
      .poll(() => list.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(await list.evaluate((element) => element.clientHeight));

    if (input === "wheel") {
      await list.hover();
      await page.mouse.wheel(0, 450);
    } else {
      const bounds = await list.boundingBox();
      if (!bounds) throw new Error("The user list is not visible");
      const client = await context.newCDPSession(page);
      const position = {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height - 30,
      };
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [position],
      });
      for (let step = 1; step <= 6; step++) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ ...position, y: position.y - step * 25 }],
        });
      }
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await client.detach();
    }
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    await page.getByRole("button", { name: "Next users" }).click();
    await expect(list.getByRole("option").first()).toContainText(
      "Scroll Person 20",
    );
    await page.getByRole("button", { name: "Previous users" }).click();
    await expect(list.getByRole("option").first()).toContainText(
      "Scroll Person 00",
    );
    await page.getByPlaceholder("Search users").fill("Scroll Person 44");
    const result = list.getByRole("option", { name: /Scroll Person 44/ });
    await expect(list.getByRole("option")).toHaveCount(1);
    await result.click();
    await expect(list).not.toBeVisible();
    await expect(picker).toContainText("Scroll Person 44 · Member");
    await expect(picker).toBeFocused();
    await expect(
      page.getByRole("button", { name: "View as user" }),
    ).toBeEnabled();

    await picker.click();
    await page.keyboard.press("Escape");
    await expect(list).not.toBeVisible();
    const dialog = page.getByRole("dialog", {
      name: "View the app as another user",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(picker).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.pointerEvents))
      .toBe("");
  });
}
