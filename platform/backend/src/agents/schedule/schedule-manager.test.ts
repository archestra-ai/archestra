import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ScheduleManager } from "./schedule-manager";

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: vi.fn().mockResolvedValue({
    messageId: "msg-test",
    text: "Test response",
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  }),
}));

vi.mock("@/models/agent-schedule-trigger", () => ({
  default: {
    findById: vi.fn(),
    findAllEnabled: vi.fn().mockResolvedValue([]),
    updateExecution: vi.fn().mockResolvedValue(undefined),
    disableOnceTriggersAfterExecution: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("ScheduleManager", () => {
  let manager: ScheduleManager;

  beforeEach(() => {
    manager = new ScheduleManager();
  });

  afterEach(() => {
    manager.shutdown();
    vi.clearAllMocks();
  });

  test("initializes with zero active jobs", () => {
    expect(manager.getActiveJobCount()).toBe(0);
    expect(manager.getRunningExecutionCount()).toBe(0);
  });

  test("schedules a cron trigger", () => {
    manager.scheduleTrigger({
      id: "test-cron-1",
      agentId: "agent-1",
      organizationId: "org-1",
      name: "Test Cron",
      triggerType: "cron",
      cronExpression: "0 9 * * MON",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Hello agent",
      enabled: true,
      misfireGraceSeconds: 60,
      lastExecutedAt: null,
      nextExecuteAt: null,
      lastStatus: null,
      lastError: null,
      executionCount: 0,
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(manager.getActiveJobCount()).toBe(1);
  });

  test("schedules an interval trigger", () => {
    manager.scheduleTrigger({
      id: "test-interval-1",
      agentId: "agent-1",
      organizationId: "org-1",
      name: "Test Interval",
      triggerType: "interval",
      cronExpression: null,
      intervalSeconds: 3600,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Hello agent",
      enabled: true,
      misfireGraceSeconds: 60,
      lastExecutedAt: null,
      nextExecuteAt: null,
      lastStatus: null,
      lastError: null,
      executionCount: 0,
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(manager.getActiveJobCount()).toBe(1);
  });

  test("removes a trigger", () => {
    manager.scheduleTrigger({
      id: "test-remove-1",
      agentId: "agent-1",
      organizationId: "org-1",
      name: "Test Remove",
      triggerType: "cron",
      cronExpression: "*/5 * * * *",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Hello",
      enabled: true,
      misfireGraceSeconds: 60,
      lastExecutedAt: null,
      nextExecuteAt: null,
      lastStatus: null,
      lastError: null,
      executionCount: 0,
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(manager.getActiveJobCount()).toBe(1);
    manager.removeTrigger("test-remove-1");
    expect(manager.getActiveJobCount()).toBe(0);
  });

  test("does not schedule disabled triggers", () => {
    manager.scheduleTrigger({
      id: "test-disabled-1",
      agentId: "agent-1",
      organizationId: "org-1",
      name: "Disabled",
      triggerType: "cron",
      cronExpression: "*/5 * * * *",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Hello",
      enabled: false,
      misfireGraceSeconds: 60,
      lastExecutedAt: null,
      nextExecuteAt: null,
      lastStatus: null,
      lastError: null,
      executionCount: 0,
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(manager.getActiveJobCount()).toBe(0);
  });

  test("shutdown stops all jobs", () => {
    manager.scheduleTrigger({
      id: "test-shutdown-1",
      agentId: "agent-1",
      organizationId: "org-1",
      name: "Shutdown Test",
      triggerType: "cron",
      cronExpression: "*/5 * * * *",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Hello",
      enabled: true,
      misfireGraceSeconds: 60,
      lastExecutedAt: null,
      nextExecuteAt: null,
      lastStatus: null,
      lastError: null,
      executionCount: 0,
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    manager.scheduleTrigger({
      id: "test-shutdown-2",
      agentId: "agent-2",
      organizationId: "org-1",
      name: "Shutdown Test 2",
      triggerType: "interval",
      cronExpression: null,
      intervalSeconds: 300,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Hello",
      enabled: true,
      misfireGraceSeconds: 60,
      lastExecutedAt: null,
      nextExecuteAt: null,
      lastStatus: null,
      lastError: null,
      executionCount: 0,
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(manager.getActiveJobCount()).toBe(2);
    manager.shutdown();
    expect(manager.getActiveJobCount()).toBe(0);
  });
});
