import { describe, expect, test } from "vitest";
import { compactChatOpsResponse } from "./chatops-response";

describe("compactChatOpsResponse", () => {
  test("removes model narration around a background task start", () => {
    expect(
      compactChatOpsResponse(
        "I'll start this as a background task.\nTask 612c2ad0-ac2d-4a86-bc85-c8143bfed577 started on Codex. Poll get_task for progress.",
      ),
    ).toBe(
      "Task 612c2ad0-ac2d-4a86-bc85-c8143bfed577 started — I’ll post the result here when it’s ready.",
    );
  });

  test("leaves ordinary foreground replies unchanged", () => {
    expect(compactChatOpsResponse("The answer is 4.")).toBe("The answer is 4.");
  });
});
