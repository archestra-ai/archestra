import { E2eTestId } from "@archestra/shared";
import {
  ensureWireMockAnthropicChatProvider,
  expectChatReady,
  goToChat,
} from "../utils";
import { expect, test } from "./api-fixtures";

test("long suggestion previews stay contained without moving the hovered pill", async ({
  page,
  request,
  makeApiRequest,
  syncModels,
  deleteAgent,
}) => {
  await ensureWireMockAnthropicChatProvider({
    request,
    makeApiRequest,
    syncModels,
  });

  const prompt = [
    `Summarize https://example.com/${"long-reference-".repeat(80)}`,
    ...Array.from(
      { length: 40 },
      () => "Include clear steps, owners, verification, and a rollback plan.",
    ),
  ].join("\n");
  const response = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/agents",
    data: {
      name: `Preview layout ${Date.now()}`,
      agentType: "agent",
      scope: "personal",
      teams: [],
      suggestedPrompts: [
        { summaryTitle: "Plan a detailed release", prompt },
        {
          summaryTitle: "Summarize a document",
          prompt: "Summarize a document.",
        },
      ],
    },
  });
  const agent = await response.json();

  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await goToChat(page, { agentId: agent.id });
      await expectChatReady(page);
      const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
      const pill = page.getByRole("button", {
        name: "Plan a detailed release",
        exact: true,
      });
      await expect(pill).toBeVisible();
      const initialHeight = await textarea.evaluate((el) => el.clientHeight);
      const initialPill = await pill.boundingBox();

      await pill.hover();
      await expect(textarea).toHaveAttribute("placeholder", prompt);
      // Observe several paints: one snapshot can miss a hover/leave loop
      // caused by content sizing moving the pill out from under the pointer.
      const frames = await textarea.evaluate(async (el) => {
        const samples = [];
        for (let frame = 0; frame < 12; frame++) {
          await new Promise(requestAnimationFrame);
          samples.push({
            placeholder: el.getAttribute("placeholder"),
            height: el.clientHeight,
            width: el.clientWidth,
            scrollWidth: el.scrollWidth,
          });
        }
        return samples;
      });
      for (const frame of frames) {
        expect(frame.placeholder).toBe(prompt);
        expect(frame.height).toBe(initialHeight);
        expect(frame.scrollWidth).toBeLessThanOrEqual(frame.width);
      }
      expect((await pill.boundingBox())?.y).toBe(initialPill?.y);
      await expect(textarea).toHaveValue("");
      const preview = page.getByText(prompt, { exact: true });
      await expect(preview).toBeVisible();
      const previewBounds = await preview.boundingBox();
      const textareaBounds = await textarea.boundingBox();
      expect(previewBounds).not.toBeNull();
      expect(textareaBounds).not.toBeNull();
      if (previewBounds && textareaBounds) {
        expect(previewBounds.height).toBeLessThanOrEqual(40);
        expect(previewBounds.y + previewBounds.height).toBeLessThanOrEqual(
          textareaBounds.y + textareaBounds.height,
        );
        expect(previewBounds.x + previewBounds.width).toBeLessThanOrEqual(
          textareaBounds.x + textareaBounds.width,
        );
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);

      await textarea.hover();
      await expect(textarea).not.toHaveAttribute("placeholder", prompt);
      await textarea.fill("Keep my draft");
      await pill.hover();
      await expect(textarea).toHaveValue("Keep my draft");
      await expect(textarea).not.toHaveAttribute("placeholder", prompt);

      // The preview constraint must not disable normal draft growth/scrolling.
      await textarea.fill(prompt);
      await expect
        .poll(() => textarea.evaluate((el) => el.clientHeight))
        .toBeGreaterThan(initialHeight);
      expect(
        await textarea.evaluate((el) => el.scrollHeight > el.clientHeight),
      ).toBe(true);
      await textarea.fill("");
    }
  } finally {
    await deleteAgent(request, agent.id);
  }
});
