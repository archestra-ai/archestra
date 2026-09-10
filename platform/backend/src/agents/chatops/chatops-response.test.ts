import { describe, expect, test } from "vitest";
import { compactChatOpsResponse } from "./chatops-response";

describe("compactChatOpsResponse", () => {
  test("removes model narration around a background run start", () => {
    expect(
      compactChatOpsResponse(
        "I'll start this as a background run.\nRun 612c2ad0-ac2d-4a86-bc85-c8143bfed577 started on Codex. Poll get_run for progress.",
      ),
    ).toBe(
      "Run 612c2ad0-ac2d-4a86-bc85-c8143bfed577 started — I’ll post the result here when it’s ready.",
    );
  });

  test("still compacts the legacy 'Task <id> started' phrasing", () => {
    expect(
      compactChatOpsResponse(
        "Task 612c2ad0-ac2d-4a86-bc85-c8143bfed577 started on Codex.",
      ),
    ).toBe(
      "Run 612c2ad0-ac2d-4a86-bc85-c8143bfed577 started — I’ll post the result here when it’s ready.",
    );
  });

  test("leaves ordinary foreground replies unchanged", () => {
    expect(compactChatOpsResponse("The answer is 4.")).toBe("The answer is 4.");
  });

  test("removes narration before a structured background run launch", () => {
    const launch = [
      "🧰 *Codex is working on it*",
      "• Task: Re-run the automated review and report its verdict",
      "• Live run: https://example.com/agent/run/22e2e62d-e552-4f41-afce-415e6fb4f214",
      "• Reply in this thread to steer the running task.",
    ].join("\n");

    expect(
      compactChatOpsResponse(
        `I'll delegate this to the coding agent.\n${launch}`,
      ),
    ).toBe(launch);
  });

  test("leaves an unrelated live-run link unchanged", () => {
    const response =
      "See the existing run:\n• Live run: https://example.com/agent/run/22e2e62d-e552-4f41-afce-415e6fb4f214";

    expect(compactChatOpsResponse(response)).toBe(response);
  });
});
