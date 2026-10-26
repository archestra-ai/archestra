import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

for (const mobile of [false, true]) {
  test(`dictation survives pauses and stops into an editable draft (${mobile ? "mobile, reduced motion" : "desktop"})`, async ({
    page,
    mswControl,
  }) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    );
    if (mobile) await page.emulateMedia({ reducedMotion: "reduce" });
    const key = makeLlmProviderApiKey({ bestModelId: "model-1" });
    const agent = makeAgent({ modelId: "model-1", llmApiKeyId: key.id });
    await mswControl.registerMany([
      { method: "get", url: "/api/llm-provider-api-keys", body: [key] },
      { method: "get", url: "/api/agents/chat-roster", body: [agent] },
      { method: "get", url: `/api/agents/${agent.id}`, body: agent },
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
        body: { modelId: "model-1", chatApiKeyId: key.id },
      },
    ]);
    // Browser boundary fixtures only: never request a hardware microphone.
    await page.addInitScript(() => {
      type Run = { result(text: string): void; end(): void };
      const fixture = window as unknown as {
        __dictationRun: Run;
        SpeechRecognition: unknown;
      };
      fixture.SpeechRecognition = class {
        continuous = true;
        interimResults = true;
        lang = "";
        onstart?: () => void;
        onend?: () => void;
        onresult?: (event: {
          results: { isFinal: boolean; 0: { transcript: string } }[];
        }) => void;
        start() {
          fixture.__dictationRun = {
            result: (text) =>
              this.onresult?.({
                results: [{ isFinal: true, 0: { transcript: text } }],
              }),
            end: () => this.onend?.(),
          };
          this.onstart?.();
        }
        stop() {}
        abort() {}
      };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            const context = new AudioContext();
            const destination = context.createMediaStreamDestination();
            const source = context.createOscillator();
            const gain = context.createGain();
            gain.gain.value = 0.2;
            source.connect(gain);
            gain.connect(destination);
            source.start();
            const track = destination.stream.getTracks()[0];
            const stop = track.stop.bind(track);
            track.stop = () => {
              stop();
              void context.close();
            };
            return destination.stream;
          },
        },
      });
    });
    await page.goto("/chat");
    const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
    await textarea.fill("Typed draft");
    await page
      .getByRole("button", { name: "Start voice input", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Submit", exact: true }),
    ).toBeHidden();
    await page.evaluate(() => {
      const fixture = window as unknown as {
        __dictationRun: { result(text: string): void; end(): void };
      };
      fixture.__dictationRun.result("Before a pause.");
      fixture.__dictationRun.end();
      fixture.__dictationRun.result("After the pause.");
    });
    const stop = page.getByRole("button", {
      name: "Stop voice input",
      exact: true,
    });
    await expect(stop).toBeVisible();
    await expect(textarea).toHaveValue("Typed draft");
    await expect(
      page.getByText("Before a pause.", { exact: true }),
    ).toHaveCount(0);
    const controls = page.getByRole("group", { name: "Voice input controls" });
    const box = await controls.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error("Recording controls have no visible bounds");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(mobile ? 390 : 1280);
    const audio = await controls.locator("[data-audio-strip]").boundingBox();
    const send = await controls
      .getByRole("button", { name: "Send voice input" })
      .boundingBox();
    expect(audio?.height).toBe(32);
    expect(send?.height).toBe(32);
    expect(audio?.y).toBe(send?.y);
    await expect(
      page.getByRole("button", { name: "Cancel voice input" }),
    ).toHaveCount(0);
    if (mobile) {
      const heights = await controls
        .locator("span[style]")
        .evaluateAll((bars) => bars.map((bar) => getComputedStyle(bar).height));
      expect(heights.every((height) => height === "2px")).toBe(true);
    } else {
      await expect
        .poll(async () =>
          controls
            .locator("span[style]")
            .evaluateAll((bars) =>
              bars.some(
                (bar) =>
                  Number.parseFloat((bar as HTMLElement).style.height) > 2,
              ),
            ),
        )
        .toBe(true);
    }
    await page.screenshot({
      path: `test-results/dictation-${mobile ? "mobile" : "desktop"}.png`,
    });
    await stop.click();
    await expect(controls).toHaveAttribute("aria-busy", "true");
    await page.evaluate(() => {
      const fixture = window as unknown as {
        __dictationRun: { result(text: string): void; end(): void };
      };
      fixture.__dictationRun.result("After the pause. Final words.");
      fixture.__dictationRun.end();
    });
    await expect(textarea).toHaveValue(
      "Typed draft Before a pause. After the pause. Final words.",
    );
    await expect(textarea).toBeEditable();
    await expect(
      page.getByRole("button", { name: "Start voice input", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/chat$/);
  });
}
