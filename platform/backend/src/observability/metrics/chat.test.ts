import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

const counterInc = vi.fn();

vi.mock("prom-client", () => {
  return {
    default: {
      Counter: class {
        inc(...args: unknown[]) {
          return counterInc(...args);
        }
      },
    },
  };
});

import { initializeChatMetrics, reportChatMessageFeedback } from "./chat";

describe("chat metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeChatMetrics();
  });

  test("reports thumbs up", () => {
    reportChatMessageFeedback("up");

    expect(counterInc).toHaveBeenCalledWith({ feedback: "up" });
  });

  test("reports thumbs down", () => {
    reportChatMessageFeedback("down");

    expect(counterInc).toHaveBeenCalledWith({ feedback: "down" });
  });

  test("reports a cleared rating as 'cleared'", () => {
    reportChatMessageFeedback(null);

    expect(counterInc).toHaveBeenCalledWith({ feedback: "cleared" });
  });
});
