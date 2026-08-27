import { describe, expect, test } from "vitest";
import {
  compactChatOpsResponse,
  isBackgroundExecutionRequest,
} from "./chatops-response";

describe("compactChatOpsResponse", () => {
  test("removes model narration around a background task start", () => {
    expect(
      compactChatOpsResponse(
        "I'll start this as a background task.\n🦀 Task 612c2ad0-ac2d-4a86-bc85-c8143bfed577 started — I'll post the PR here when it's ready.",
      ),
    ).toBe(
      "🦀 Task 612c2ad0-ac2d-4a86-bc85-c8143bfed577 started — I’ll post the PR here when it’s ready.",
    );
  });

  test("leaves ordinary foreground replies unchanged", () => {
    expect(compactChatOpsResponse("The answer is 4.")).toBe("The answer is 4.");
  });

  test("recognizes the concise Slack background marker", () => {
    expect(isBackgroundExecutionRequest("🦀 fix the failing test")).toBe(true);
    expect(isBackgroundExecutionRequest("  :crab: open a PR")).toBe(true);
    expect(isBackgroundExecutionRequest("what is 2 + 2?")).toBe(false);
  });
});
