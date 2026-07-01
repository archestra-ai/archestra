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

import { initializeAuditMetrics, reportAuditWriteFailure } from "./audit";

describe("audit metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeAuditMetrics();
  });

  test("reports an http write failure with resource type", () => {
    reportAuditWriteFailure({ source: "http", resourceType: "agent" });

    expect(counterInc).toHaveBeenCalledWith({
      source: "http",
      resource_type: "agent",
    });
  });

  test("reports an auth write failure", () => {
    reportAuditWriteFailure({ source: "auth", resourceType: "auth" });

    expect(counterInc).toHaveBeenCalledWith({
      source: "auth",
      resource_type: "auth",
    });
  });

  test("falls back to 'unknown' when resource type is null", () => {
    reportAuditWriteFailure({ source: "http", resourceType: null });

    expect(counterInc).toHaveBeenCalledWith({
      source: "http",
      resource_type: "unknown",
    });
  });
});
