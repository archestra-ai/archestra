import { describe, expect, test } from "vitest";
import {
  AGENT_TOOL_PREFIX,
  isAgentTool,
  makeSwapAgentPokeText,
  SWAP_AGENT_POKE_PREFIX,
  describeScheduleTrigger,
  isCronTrigger,
  isIntervalTrigger,
  isOnceTrigger,
  isScheduleTriggerEnabled,
  validateScheduleTrigger,
  type AgentCronScheduleTrigger,
  type AgentIntervalScheduleTrigger,
  type AgentOnceScheduleTrigger,
  type AgentScheduleTriggerConfig,
} from "./agents";
import { TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME } from "./archestra-mcp-server";

describe("agent tool helpers", () => {
  test("identifies delegation tools by prefix", () => {
    expect(isAgentTool(`${AGENT_TOOL_PREFIX}delegate_to_researcher`)).toBe(
      true,
    );
    expect(isAgentTool("archestra__swap_agent")).toBe(false);
  });

  test("builds swap poke text using the shared swap-to-default tool name", () => {
    const text = makeSwapAgentPokeText("Research Agent");
    expect(text.startsWith(`${SWAP_AGENT_POKE_PREFIX}Research Agent`)).toBe(
      true,
    );
    expect(text).toContain(TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME);
  });
});

describe("agent schedule triggers", () => {
  test("isCronTrigger narrows type correctly", () => {
    const cron: AgentCronScheduleTrigger = { type: "cron", expression: "0 9 * * 1-5" };
    expect(isCronTrigger(cron)).toBe(true);
    expect(isIntervalTrigger(cron)).toBe(false);
    expect(isOnceTrigger(cron)).toBe(false);
  });

  test("isIntervalTrigger narrows type correctly", () => {
    const interval: AgentIntervalScheduleTrigger = { type: "interval", intervalMs: 60000 };
    expect(isIntervalTrigger(interval)).toBe(true);
    expect(isCronTrigger(interval)).toBe(false);
    expect(isOnceTrigger(interval)).toBe(false);
  });

  test("isOnceTrigger narrows type correctly", () => {
    const once: AgentOnceScheduleTrigger = { type: "once", at: "2025-01-01T09:00:00Z" };
    expect(isOnceTrigger(once)).toBe(true);
    expect(isCronTrigger(once)).toBe(false);
    expect(isIntervalTrigger(once)).toBe(false);
  });

  test("describeScheduleTrigger uses label when present", () => {
    const cron: AgentCronScheduleTrigger = {
      type: "cron",
      expression: "0 9 * * 1-5",
      label: "Weekday morning",
    };
    expect(describeScheduleTrigger(cron)).toBe("Weekday morning");
  });

  test("describeScheduleTrigger formats cron without label", () => {
    const cron: AgentCronScheduleTrigger = { type: "cron", expression: "0 9 * * 1-5" };
    expect(describeScheduleTrigger(cron)).toBe("Cron: 0 9 * * 1-5");
  });

  test("describeScheduleTrigger formats interval without label", () => {
    const interval: AgentIntervalScheduleTrigger = { type: "interval", intervalMs: 30000 };
    expect(describeScheduleTrigger(interval)).toBe("Every 30000ms");
  });

  test("describeScheduleTrigger formats once without label", () => {
    const once: AgentOnceScheduleTrigger = { type: "once", at: "2025-06-01T12:00:00Z" };
    expect(describeScheduleTrigger(once)).toBe("Once at 2025-06-01T12:00:00Z");
  });

  test("isScheduleTriggerEnabled returns enabled flag", () => {
    const config: AgentScheduleTriggerConfig = {
      id: "sched-1",
      agentId: "agent-1",
      trigger: { type: "cron", expression: "0 9 * * *" },
      prompt: "Run daily report",
      enabled: true,
    };
    expect(isScheduleTriggerEnabled(config)).toBe(true);
    expect(isScheduleTriggerEnabled({ ...config, enabled: false })).toBe(false);
  });

  describe("validateScheduleTrigger", () => {
    test("accepts a valid cron expression", () => {
      expect(
        validateScheduleTrigger({ type: "cron", expression: "0 9 * * 1-5" }),
      ).toEqual([]);
    });

    test("rejects an empty cron expression", () => {
      const errors = validateScheduleTrigger({ type: "cron", expression: "" });
      expect(errors.length).toBeGreaterThan(0);
    });

    test("rejects a cron expression with wrong number of fields", () => {
      const errors = validateScheduleTrigger({
        type: "cron",
        expression: "0 9 *",
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    test("accepts a valid interval", () => {
      expect(
        validateScheduleTrigger({ type: "interval", intervalMs: 60000 }),
      ).toEqual([]);
    });

    test("rejects a non-positive interval", () => {
      const errors = validateScheduleTrigger({
        type: "interval",
        intervalMs: 0,
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    test("rejects a negative interval", () => {
      const errors = validateScheduleTrigger({
        type: "interval",
        intervalMs: -1000,
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    test("accepts a valid once trigger", () => {
      expect(
        validateScheduleTrigger({
          type: "once",
          at: "2025-12-31T23:59:59Z",
        }),
      ).toEqual([]);
    });

    test("rejects an invalid datetime in once trigger", () => {
      const errors = validateScheduleTrigger({
        type: "once",
        at: "not-a-date",
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    test("rejects an empty 'at' in once trigger", () => {
      const errors = validateScheduleTrigger({ type: "once", at: "" });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});