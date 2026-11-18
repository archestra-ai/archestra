import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import { makeAgent } from "../src/mocks/data/agents";
import { makeUserPermissions } from "../src/mocks/data/auth";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1280, height: 1100 },
  { width: 1280, height: 500 },
]) {
  test(`keeps the agent picker anchored while searching at ${viewport.width}x${viewport.height}`, async ({
    page,
    mswControl,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const key = makeLlmProviderApiKey({ bestModelId: "model-1" });
    const agents = Array.from({ length: 20 }, (_, index) =>
      makeAgent({
        id: `choice-${index}`,
        name: `Choice ${String(index).padStart(2, "0")}`,
        scope: "org",
        accessAllTools: true,
      }),
    );
    const batch = (data: typeof agents) => ({
      data,
      pagination: { limit: 20, hasNext: false, nextCursor: null },
    });
    await mswControl.registerMany([
      {
        method: "get",
        url: "/api/user/permissions",
        body: makeUserPermissions({
          chat: ["read", "create", "update", "delete", "full-view"],
        }),
      },
      { method: "get", url: "/api/llm-provider-api-keys", body: [key] },
      {
        method: "get",
        url: "/api/llm-provider-api-keys/available",
        body: [key],
      },
      {
        method: "get",
        url: "/api/llm-models/available",
        body: [
          {
            dbId: "model-1",
            id: "test-model",
            displayName: "Test model",
            provider: "anthropic",
            isFree: false,
            isBest: true,
          },
        ],
      },
      {
        method: "get",
        url: "/api/members/default-model",
        body: { modelId: null, chatApiKeyId: null },
      },
      { method: "get", url: "/api/agents/chat-roster", body: [agents[0]] },
      { method: "get", url: `/api/agents/${agents[0].id}`, body: agents[0] },
      { method: "get", url: `/api/agents/${agents[1].id}`, body: agents[1] },
      {
        method: "get",
        url: "/api/agents/chat-roster/page",
        body: batch(agents),
      },
      {
        method: "get",
        url: "/api/agents/chat-roster/page",
        query: { search: "Choice 01" },
        body: batch([agents[1]]),
        delayMs: 500,
      },
      {
        method: "get",
        url: "/api/agents/chat-roster/page",
        query: { search: "unmatched" },
        body: batch([]),
      },
    ]);
    await page.goto("/chat");
    const draft = page.getByTestId(E2eTestId.ChatPromptTextarea);
    await draft.fill("Keep this draft while searching");
    await page
      .getByRole("combobox", { name: "Choice 00", exact: true })
      .click();
    const picker = page.getByRole("dialog");
    const search = picker.getByRole("combobox", { name: "Search agents" });
    const list = picker.getByRole("listbox", { name: "Agents" });
    await expect(list.getByRole("option")).toHaveCount(20);
    await expect(search).toBeFocused();
    // Wait for the opening animation before measuring browser layout.
    await picker.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    const initialPicker = await picker.boundingBox();
    const initialSearch = await search.boundingBox();
    expect(initialPicker).not.toBeNull();
    expect(initialSearch).not.toBeNull();

    const expectAnchored = async () => {
      const bounds = await picker.boundingBox();
      const searchBounds = await search.boundingBox();
      expect(bounds).not.toBeNull();
      expect(searchBounds).not.toBeNull();
      expect(bounds?.x).toBeCloseTo(initialPicker?.x ?? 0, 0);
      expect(bounds?.y).toBeCloseTo(initialPicker?.y ?? 0, 0);
      expect(bounds?.height).toBeCloseTo(initialPicker?.height ?? 0, 0);
      expect(searchBounds?.y).toBeCloseTo(initialSearch?.y ?? 0, 0);
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect(bounds?.y).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
        viewport.width,
      );
      expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(
        viewport.height,
      );
      await expect(
        picker.getByRole("link", { name: "All agents" }),
      ).toBeInViewport();
      await expect(search).toBeFocused();
    };

    await search.fill("Choice 01");
    await expect(list.getByText("Loading agents…")).toBeVisible();
    await expectAnchored();
    await expect(list.getByRole("option")).toHaveCount(1);
    await expectAnchored();
    await testInfo.attach("filtered-picker", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await search.fill("unmatched");
    await expect(list.getByText('No agents match "unmatched"')).toBeVisible();
    await expectAnchored();
    await search.clear();
    await expect(list.getByRole("option")).toHaveCount(20);
    await expectAnchored();
    await search.fill("Choice 01");
    await expect(list.getByRole("option")).toHaveCount(1);
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(picker).toBeHidden();
    await expect(
      page.getByRole("combobox", { name: "Choice 01", exact: true }),
    ).toBeVisible();
    await expect(draft).toHaveValue("Keep this draft while searching");
  });
}
