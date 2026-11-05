// @vitest-environment node
import { describe, expect, it } from "vitest";
import { composerMorph } from "./composer-morph";

describe("composerMorph", () => {
  it("morphs when arriving from the new-chat composer, not when switching between conversations", () => {
    // From the splash: no conversation composer is mounted yet.
    expect(composerMorph.shouldMorph()).toBe(true);
    const leaveFirst = composerMorph.registerConversationComposer();

    // Switching: the next conversation renders while the first is mounted.
    expect(composerMorph.shouldMorph()).toBe(false);
    const leaveSecond = composerMorph.registerConversationComposer();
    leaveFirst();
    expect(composerMorph.shouldMorph()).toBe(false);

    // Back to new chat and then into a conversation again.
    leaveSecond();
    expect(composerMorph.shouldMorph()).toBe(true);
  });
});
