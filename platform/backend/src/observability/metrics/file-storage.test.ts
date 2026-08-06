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
  initializeFileStorageMetrics,
  reportOrphanedObject,
} from "./file-storage";

describe("file storage metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeFileStorageMetrics();
  });

  test("reports an orphaned object with its provider and scope", () => {
    reportOrphanedObject({ provider: "filesystem", scope: "project" });

    expect(counterInc).toHaveBeenCalledWith({
      provider: "filesystem",
      scope: "project",
    });
  });

  test("counts each orphan separately, so an outage reads louder than one miss", () => {
    reportOrphanedObject({ provider: "s3", scope: "project" });
    reportOrphanedObject({ provider: "s3", scope: "project" });

    expect(counterInc).toHaveBeenCalledTimes(2);
  });
});
