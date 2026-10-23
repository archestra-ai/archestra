import type {
  ScheduleTrigger,
  ScheduleTriggerRun,
} from "@/lib/schedule-trigger.query";

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const AGENT_ID = "33333333-3333-4333-8333-333333333331";
export const SECOND_AGENT_ID = "33333333-3333-4333-8333-333333333332";
export const SYNTHETIC_SCHEDULES: ScheduleTrigger[] = [
  {
    id: "22222222-2222-4222-8222-222222222221",
    organizationId: "test-org",
    name: "Morning briefing",
    agentId: AGENT_ID,
    projectId: PROJECT_ID,
    messageTemplate:
      "Summarize today’s calendar and repository activity. Prepare a short briefing for review.",
    cronExpression: "0 8 * * *",
    timezone: "America/New_York",
    enabled: true,
    actorUserId: "test-user-admin",
    lastExecutedAt: "2026-10-23T12:00:00Z",
    createdAt: "2026-10-01T12:00:00Z",
    agent: { id: AGENT_ID, name: "Briefing assistant", agentType: "agent" },
    actor: {
      id: "test-user-admin",
      name: "Demo user",
      email: "demo@example.test",
    },
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    organizationId: "test-org",
    name: "Weekly planning digest",
    agentId: AGENT_ID,
    projectId: "11111111-1111-4111-8111-111111111112",
    messageTemplate:
      "Review the coming week’s calendar and draft a planning digest.",
    cronExpression: "0 9 * * 1",
    timezone: "America/New_York",
    enabled: true,
    actorUserId: "test-user-admin",
    lastExecutedAt: "2026-10-19T13:00:00Z",
    createdAt: "2026-10-01T12:00:00Z",
    agent: { id: AGENT_ID, name: "Briefing assistant", agentType: "agent" },
  },
  {
    id: "22222222-2222-4222-8222-222222222223",
    organizationId: "test-org",
    name: "Release notes review",
    agentId: SECOND_AGENT_ID,
    projectId: PROJECT_ID,
    messageTemplate:
      "Collect merged changes and prepare release note suggestions for review.",
    cronExpression: "0 16 * * 5",
    timezone: "America/New_York",
    enabled: false,
    actorUserId: "test-user-admin",
    lastExecutedAt: "2026-10-16T20:00:00Z",
    createdAt: "2026-10-01T12:00:00Z",
    agent: {
      id: SECOND_AGENT_ID,
      name: "Release assistant",
      agentType: "agent",
    },
  },
];
// The API preview contains 1,000 runs; callers receive only their requested page.
export const PREVIEW_RUN_TOTAL = 1000;
export function syntheticRun(
  triggerId: string,
  i: number,
): ScheduleTriggerRun | null {
  const schedule = SYNTHETIC_SCHEDULES.find((s) => s.id === triggerId);
  if (!schedule || i < 0 || i >= PREVIEW_RUN_TOTAL) return null;
  const scheduleIndex = SYNTHETIC_SCHEDULES.indexOf(schedule);
  const started = new Date(
    Date.parse(schedule.lastExecutedAt ?? "2026-10-23T12:00:00Z") -
      i * (scheduleIndex === 1 ? 7 : 1) * 86400000 +
      (i === 2 ? 7200000 : 0),
  ).toISOString();
  const failed = i % 10 === 0 || i % 10 === 4;
  const cancelled = i % 10 === 7;
  const manual = i % 10 === 2;
  const conversationSequence =
    i < 100
      ? scheduleIndex * 100 + i + 1
      : 10000 + scheduleIndex * 10000 + i + 1;
  return {
    id: `${(0xa1200000 + i).toString(16)}-4444-4444-8444-444444444444`,
    organizationId: "test-org",
    triggerId,
    runKind: manual ? "manual" : "due",
    status: failed ? "failed" : cancelled ? "cancelled" : "success",
    initiatedByUserId: manual ? "test-user-admin" : null,
    chatConversationId: `55555555-5555-4555-8555-${String(conversationSequence).padStart(12, "0")}`,
    runtimeTaskId: null,
    startedAt: started,
    completedAt: new Date(
      Date.parse(started) + (failed ? 18000 : 74000 + (i % 20) * 3000),
    ).toISOString(),
    error: failed
      ? "The calendar connection needs to be reconnected before this task can finish."
      : null,
    artifact:
      failed || cancelled
        ? null
        : "Task completed. Output is available in the conversation.",
    createdAt: started,
  };
}
// Project preview lists stay intentionally small; history uses the paginated API below.
export function syntheticRuns(triggerId: string): ScheduleTriggerRun[] {
  return Array.from({ length: 12 }, (_, i) =>
    syntheticRun(triggerId, i),
  ).filter((r): r is ScheduleTriggerRun => !!r);
}
export function syntheticRunPage(
  triggerId: string,
  limit: number,
  offset: number,
  status?: string,
  runKind?: string,
) {
  const matches = SYNTHETIC_SCHEDULES.some((s) => s.id === triggerId)
    ? Array.from({ length: PREVIEW_RUN_TOTAL }, (_, i) => i).filter(
        (i) =>
          !status ||
          (i % 10 === 0 || i % 10 === 4
            ? "failed"
            : i % 10 === 7
              ? "cancelled"
              : "success") === status,
      )
    : [];
  const filtered = matches.filter(
    (i) => !runKind || (i % 10 === 2 ? "manual" : "due") === runKind,
  );
  const total = filtered.length;
  return {
    data: filtered
      .slice(offset, offset + limit)
      .map((i) => syntheticRun(triggerId, i)!),
    pagination: {
      currentPage: Math.floor(offset / limit) + 1,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: offset + limit < total,
      hasPrev: offset > 0,
    },
  };
}
