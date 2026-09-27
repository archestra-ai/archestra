import { describe, expect, it } from "vitest";
import { extractTaggedText } from "./generate-tagged-text";

describe("extractTaggedText", () => {
  it("extracts the content inside the tag", () => {
    expect(extractTaggedText("<x>hello</x>", "x")).toBe("hello");
  });

  it("ignores reasoning or prose outside the tag", () => {
    const raw = "Let me think...\n<x>the answer</x>\nDone.";
    expect(extractTaggedText(raw, "x")).toBe("the answer");
  });

  it("trims surrounding whitespace inside the tag", () => {
    expect(extractTaggedText("<x>\n  spaced  \n</x>", "x")).toBe("spaced");
  });

  it("returns null when the tag is absent", () => {
    expect(extractTaggedText("just a bare sentence", "x")).toBeNull();
  });

  it("returns null when the closing tag is missing", () => {
    expect(extractTaggedText("<x>unterminated", "x")).toBeNull();
  });

  it("returns null when the tag wraps only whitespace", () => {
    expect(extractTaggedText("<x>   </x>", "x")).toBeNull();
  });
});
