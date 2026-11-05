import { describe, expect, it } from "vitest";
import { branchesToOpen } from "./payload-open";

describe("branchesToOpen", () => {
  it("opens a small payload whole", () => {
    const request = {
      model: "claude",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    const open = branchesToOpen(request, 100);

    expect(open.has(request)).toBe(true);
    expect(open.has(request.messages)).toBe(true);
    expect(open.has(request.messages[0])).toBe(true);
    expect(open.has(request.messages[0].content)).toBe(true);
    expect(open.has(request.messages[0].content[0])).toBe(true);
  });

  it("opens levels breadth first and leaves what does not fit folded", () => {
    const request = {
      tools: Array.from({ length: 50 }, (_, i) => ({ name: `tool${i}` })),
      system: [{ type: "text", text: "be brief" }],
    };
    const open = branchesToOpen(request, 10);

    expect(open.has(request)).toBe(true);
    // 50 tools cost 50 rows and do not fit; the one system block does.
    expect(open.has(request.tools)).toBe(false);
    expect(open.has(request.system)).toBe(true);
    expect(open.has(request.system[0])).toBe(true);
  });

  it("counts a long array as its groups, and opens none of its items", () => {
    const messages = Array.from({ length: 483 }, (_, i) => ({ i }));
    const request = { messages };
    const open = branchesToOpen(request, 10);

    // 483 items show as 5 groups of up to 100.
    expect(open.has(messages)).toBe(true);
    expect(open.has(messages[0])).toBe(false);
  });

  it("opens nothing for a payload that is not an object", () => {
    expect(branchesToOpen("plain text", 100)).toBeInstanceOf(WeakSet);
  });
});
