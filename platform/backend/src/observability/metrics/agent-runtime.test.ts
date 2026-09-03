import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

const counterInc = vi.fn();

vi.mock("prom-client", () => ({
  default: {
    Counter: class {
      inc(...args: unknown[]) {
        return counterInc(...args);
      }
    },
    Histogram: class {
      observe() {}
    },
  },
}));

import {
  initializeAgentRuntimeMetrics,
  reportAgentRunCompletionDelivery,
} from "./agent-runtime";

describe("Agent Runtime completion metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeAgentRuntimeMetrics();
  });

  test("reports the external interface and delivery outcome", () => {
    reportAgentRunCompletionDelivery("email", "success");

    expect(counterInc).toHaveBeenCalledWith({
      interface: "email",
      outcome: "success",
    });
  });
});
