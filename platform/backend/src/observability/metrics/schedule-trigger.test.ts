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

import {
  initializeScheduleTriggerMetrics,
  reportScheduleTriggerRun,
} from "./schedule-trigger";

describe("schedule-trigger metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeScheduleTriggerMetrics();
  });

  test("reports successful run", () => {
    reportScheduleTriggerRun("My Agent", "success");

    expect(counterInc).toHaveBeenCalledWith({
      agent_name: "My Agent",
      status: "success",
    });
  });

  test("reports failed run", () => {
    reportScheduleTriggerRun("My Agent", "failed");

    expect(counterInc).toHaveBeenCalledWith({
      agent_name: "My Agent",
      status: "failed",
    });
  });

  test("reports unknown agent name", () => {
    reportScheduleTriggerRun("unknown", "failed");

    expect(counterInc).toHaveBeenCalledWith({
      agent_name: "unknown",
      status: "failed",
    });
  });
});
