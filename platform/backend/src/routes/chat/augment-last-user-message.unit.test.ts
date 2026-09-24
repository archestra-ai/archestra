import type { ChatMessage } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { spliceText } from "./augment-last-user-message";

const text = (message: ChatMessage, index: number): string | undefined =>
  message.parts?.filter((p) => p.type === "text")[index]?.text;

describe("spliceText", () => {
  it("prepends to the first text part and appends to the last", () => {
    const message: ChatMessage = {
      role: "user",
      parts: [
        { type: "text", text: "first" },
        { type: "text", text: "last" },
      ],
    };

    expect(text(spliceText(message, "BLOCK", "prepend"), 0)).toBe(
      "BLOCK\n\nfirst",
    );
    expect(text(spliceText(message, "BLOCK", "append"), 1)).toBe(
      "last\n\nBLOCK",
    );
  });

  it("adds a text part at the matching end when none exists", () => {
    const message: ChatMessage = {
      role: "user",
      parts: [
        { type: "file", url: "data:text/plain,x", mediaType: "text/plain" },
      ],
    };

    const prepended = spliceText(message, "BLOCK", "prepend");
    expect(prepended.parts?.[0]).toEqual({ type: "text", text: "BLOCK" });

    const appended = spliceText(message, "BLOCK", "append");
    expect(appended.parts?.at(-1)).toEqual({ type: "text", text: "BLOCK" });
  });

  it("does not mutate the original message", () => {
    const message: ChatMessage = {
      role: "user",
      parts: [{ type: "text", text: "original" }],
    };
    spliceText(message, "BLOCK", "prepend");
    expect(message.parts?.[0].text).toBe("original");
  });

  it("keeps skill-prepend and diagnostics-append independent on one message", () => {
    // Mirrors routes.ts injecting skill (prepend) then diagnostics (append) on
    // a message carrying both metadata kinds: skill rides the first text part,
    // diagnostics the last, with no reordering.
    const message: ChatMessage = {
      role: "user",
      parts: [
        { type: "text", text: "first" },
        { type: "text", text: "last" },
      ],
    };

    const withSkill = spliceText(message, "SKILL", "prepend");
    const withBoth = spliceText(withSkill, "DIAGNOSTICS", "append");

    expect(text(withBoth, 0)).toBe("SKILL\n\nfirst");
    expect(text(withBoth, 1)).toBe("last\n\nDIAGNOSTICS");
  });
});
