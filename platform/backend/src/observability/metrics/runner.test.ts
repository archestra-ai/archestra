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
  initializeRunnerMetrics,
  reportRunnerCompletionDelivery,
} from "./runner";

describe("runner completion metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeRunnerMetrics();
  });

  test("reports the external interface and delivery outcome", () => {
    reportRunnerCompletionDelivery("email", "success");

    expect(counterInc).toHaveBeenCalledWith({
      interface: "email",
      outcome: "success",
    });
  });
});
