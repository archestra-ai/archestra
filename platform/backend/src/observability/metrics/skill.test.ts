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

import { initializeSkillMetrics, reportSkillActivation } from "./skill";

describe("skill metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeSkillMetrics();
  });

  test("a measured activation counts once and adds its tokens", () => {
    reportSkillActivation({
      activationType: "slash_command",
      contextTokens: 1234,
    });

    expect(counterInc).toHaveBeenCalledWith({
      activation_type: "slash_command",
    });
    expect(counterInc).toHaveBeenCalledWith(
      { activation_type: "slash_command" },
      1234,
    );
  });

  test("an unmeasured activation still counts, but adds no tokens", () => {
    reportSkillActivation({
      activationType: "load_skill",
      contextTokens: null,
    });

    expect(counterInc).toHaveBeenCalledTimes(1);
    expect(counterInc).toHaveBeenCalledWith({ activation_type: "load_skill" });
  });

  test("a zero measurement adds nothing to the token counter", () => {
    reportSkillActivation({ activationType: "delegation", contextTokens: 0 });

    expect(counterInc).toHaveBeenCalledTimes(1);
    expect(counterInc).toHaveBeenCalledWith({ activation_type: "delegation" });
  });
});
