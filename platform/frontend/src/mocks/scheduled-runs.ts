import { HttpResponse, http } from "msw";
import {
  makeAgent,
  makeAgentCatalog,
  makeAgentsList,
} from "@/mocks/data/agents";
import { adminPermissionsSeed } from "@/mocks/data/auth";
import { configSeed } from "@/mocks/data/config";
import { makeLlmProviderApiKey } from "@/mocks/data/llm-keys";
import {
  addPreviewProject,
  addPreviewSchedule,
  previewProjects,
  previewSchedules,
} from "./data/schedule-preview-store";
import {
  AGENT_ID,
  PROJECT_ID,
  SECOND_AGENT_ID,
  SYNTHETIC_SCHEDULES,
  syntheticRun,
  syntheticRunPage,
  syntheticRuns,
} from "./data/scheduled-runs";

const agents = [
  makeAgent({
    id: AGENT_ID,
    name: "Briefing assistant",
    description: "Calendar and repository briefings",
    authorName: "Demo user",
  }),
  makeAgent({
    id: SECOND_AGENT_ID,
    name: "Release assistant",
    description: "Release note preparation",
    authorName: "Demo user",
  }),
  makeAgent({
    id: "33333333-3333-4333-8333-333333333333",
    name: "Research assistant",
    description: "Ad hoc research",
    authorName: "Demo user",
  }),
];
function page<T>(data: T[]) {
  return {
    data,
    pagination: {
      currentPage: 1,
      limit: 100,
      total: data.length,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    },
  };
}
function project(id: string) {
  const saved = previewProjects().find((p) => p.id === id);
  const defaultAgentId = saved?.defaultAgentId ?? AGENT_ID;
  const agent = agents.find((a) => a.id === defaultAgentId) ?? agents[0];
  return {
    id,
    organizationId: "test-org",
    name: saved?.name ?? "Preview project",
    description: "Synthetic schedule review project",
    authorId: "test-user-admin",
    createdByServiceAccountId: null,
    scope: "personal",
    viewerRole: "owner",
    ownerName: "Demo user",
    createdBy: {
      id: "test-user-admin",
      name: "Demo user",
      email: "demo@example.test",
      image: null,
    },
    visibility: "user",
    conversationCount: previewSchedules()
      .filter((s) => s.projectId === id)
      .flatMap((s) => syntheticRuns(s.id)).length,
    shareTeamNames: null,
    shareUserNames: null,
    shareTeamIds: null,
    shareUserIds: null,
    defaultAgent: {
      id: agent.id,
      name: agent.name,
      agentType: "agent",
      icon: null,
    },
    defaultAgentId,
    icon: null,
    labels: [],
    teams: [],
    createdAt: "2026-10-01T12:00:00Z",
    updatedAt: "2026-10-23T12:00:00Z",
    deletedAt: null,
    pinnedAt: null,
  };
}
function conversation(id: string) {
  const sequence = Math.max(0, Number(id.slice(-12)) - 1);
  const scheduleIndex =
    sequence >= 10000
      ? Math.floor((sequence - 10000) / 10000)
      : Math.floor(sequence / 100);
  const n = sequence >= 10000 ? (sequence - 10000) % 10000 : sequence % 100;
  const schedule = SYNTHETIC_SCHEDULES[scheduleIndex] ?? SYNTHETIC_SCHEDULES[0];
  const r = syntheticRun(schedule.id, n) ?? syntheticRun(schedule.id, 0)!;
  return {
    id,
    userId: "test-user-admin",
    organizationId: "test-org",
    agentId: schedule.agentId,
    title: `${schedule.name} · ${new Date(r.startedAt!).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    titleIsPlaceholder: false,
    origin: "schedule_trigger",
    projectId: schedule.projectId,
    modelId: null,
    selectedModel: "gpt-4o",
    selectedProvider: "openai",
    chatApiKeyId: null,
    thinkingEffort: "low",
    hasCustomToolSelection: false,
    hooksDebugEnabled: false,
    encryptedChat: false,
    todoList: null,
    artifact: null,
    pinnedAt: null,
    createdAt: r.createdAt,
    updatedAt: r.completedAt,
    lastMessageAt: r.completedAt,
    deletedAt: null,
    agent: {
      ...(agents.find((a) => a.id === schedule.agentId) ?? agents[0]),
      toolExposureMode: "full",
      llmApiKeyId: null,
    },
    share: null,
    chatErrors: [],
    compactions: [],
    messages: [
      {
        id: `prompt-${n}`,
        role: "user",
        parts: [{ type: "text", text: schedule.messageTemplate }],
      },
      {
        id: `response-${n}`,
        role: "assistant",
        parts: [
          {
            type: "text",
            text: r.error
              ? "I couldn’t complete this briefing because the calendar connection needs to be reconnected. After reconnecting, you can start another run from this schedule."
              : "Your morning briefing is ready.\n\n**Calendar**\nThree meetings today: planning at 10:00, project review at 13:00, and a team sync at 15:00.\n\n**Repository activity**\nSix changes merged yesterday. The next release draft is ready for review.\n\nOpen a different execution in Runs to review its conversation.",
          },
        ],
      },
    ],
  };
}
function agentOptions(request: Request) {
  const q = new URL(request.url).searchParams;
  return {
    data: agents.filter(
      (a) =>
        (!q.get("ids") || q.get("ids")!.split(",").includes(a.id)) &&
        (!q.get("search") ||
          a.name.toLowerCase().includes(q.get("search")!.toLowerCase())),
    ),
    pagination: { limit: 100, nextCursor: null, hasNext: false },
  };
}
export const scheduledRunsHandlers = [
  http.get("/api/agents/options/page", ({ request }) =>
    HttpResponse.json(agentOptions(request)),
  ),
  http.get("/api/agents/options/ids", () =>
    HttpResponse.json(agents.map((a) => a.id)),
  ),
  http.get("/api/agents/options", ({ request }) =>
    HttpResponse.json(agentOptions(request)),
  ),
  http.get("/api/agents/:id/tool-exclusions", () =>
    HttpResponse.json({ excludedToolIds: [] }),
  ),
  http.get("/api/agents/:id/subagent-exclusions", () =>
    HttpResponse.json({ excludedSubagentIds: [] }),
  ),
  http.get("/api/agents/:id/knowledge-source-exclusions", () =>
    HttpResponse.json({ excludedConnectorIds: [] }),
  ),
  http.get("/api/agents/:id/activation-skill-policy", () =>
    HttpResponse.json({
      mode: "all",
      revision: 0,
      allowedReferences: [],
      excludedReferences: [],
      allowedSkills: [],
      excludedSkills: [],
      hiddenAllowedCount: 0,
      hiddenExcludedCount: 0,
    }),
  ),

  http.get("/api/llm-provider-api-keys", () =>
    HttpResponse.json([
      makeLlmProviderApiKey({ provider: "openai", name: "Preview provider" }),
    ]),
  ),
  http.get("/api/llm-provider-api-keys/available", () =>
    HttpResponse.json([
      makeLlmProviderApiKey({ provider: "openai", name: "Preview provider" }),
    ]),
  ),
  http.get("/api/members/default-model", () =>
    HttpResponse.json({ modelId: null, chatApiKeyId: null }),
  ),

  http.get("/api/agents/chat-roster", () => HttpResponse.json(agents)),
  http.get("/api/agents/credential-readiness", () => HttpResponse.json([])),
  http.get("/api/chat/conversations/:id/files", () => HttpResponse.json([])),
  http.get("/api/chat/conversations/:id/share", () => HttpResponse.json(null)),
  http.get("/api/chat/conversations/:id", ({ params }) =>
    HttpResponse.json(conversation(String(params.id))),
  ),
  http.get("/api/schedule-triggers/:id/runs/:runId", ({ params }) =>
    HttpResponse.json(
      syntheticRun(
        String(params.id),
        parseInt(String(params.runId).slice(0, 8), 16) - 0xa1200000,
      ),
    ),
  ),

  http.get("/api/user/permissions", () =>
    HttpResponse.json({
      ...adminPermissionsSeed,
      project: ["read", "create", "update", "delete"],
      conversation: ["read", "create", "update", "delete"],
      agentRun: ["read", "create", "update", "delete"],
    }),
  ),
  http.get("/api/config", () =>
    HttpResponse.json({
      ...configSeed,
      features: { ...configSeed.features, projects: true },
    }),
  ),
  http.get("/api/schedule-triggers", ({ request }) => {
    const q = new URL(request.url).searchParams;
    const list = previewSchedules().filter(
      (s) =>
        (!q.get("agentIds") ||
          q.get("agentIds")!.split(",").includes(s.agentId)) &&
        (!q.get("projectId") || q.get("projectId") === s.projectId),
    );
    const limit = Math.max(1, Number(q.get("limit")) || 25);
    const offset = Math.max(0, Number(q.get("offset")) || 0);
    return HttpResponse.json({
      data: list.slice(offset, offset + limit),
      pagination: {
        currentPage: Math.floor(offset / limit) + 1,
        limit,
        total: list.length,
        totalPages: Math.ceil(list.length / limit),
        hasNext: offset + limit < list.length,
        hasPrev: offset > 0,
      },
    });
  }),
  http.get("/api/schedule-triggers/:id/runs", ({ params, request }) => {
    const q = new URL(request.url).searchParams;
    const limit = Math.max(1, Math.min(100, Number(q.get("limit")) || 25));
    const offset = Math.max(0, Number(q.get("offset")) || 0);
    return HttpResponse.json(
      syntheticRunPage(
        String(params.id),
        limit,
        offset,
        q.get("status") ?? undefined,
        q.get("runKind") ?? undefined,
      ),
    );
  }),
  http.get("/api/schedule-triggers/:id", ({ params }) =>
    HttpResponse.json(
      previewSchedules().find((s) => s.id === params.id) ??
        SYNTHETIC_SCHEDULES[0],
    ),
  ),
  http.post("/api/schedule-triggers/:id/run", () =>
    HttpResponse.json(
      { error: "Schedule preview is read-only" },
      { status: 405 },
    ),
  ),
  http.put("/api/schedule-triggers/:id", () =>
    HttpResponse.json(
      { error: "Schedule preview is read-only" },
      { status: 405 },
    ),
  ),
  http.delete("/api/schedule-triggers/:id", () =>
    HttpResponse.json(
      { error: "Schedule preview is read-only" },
      { status: 405 },
    ),
  ),
  http.post("/api/schedule-triggers", async ({ request }) => {
    const body = (await request.json()) as {
      name: string;
      agentId: string;
      projectId: string;
      messageTemplate: string;
      cronExpression: string;
      timezone: string;
      enabled: boolean;
    };
    const agent = agents.find((a) => a.id === body.agentId);
    if (
      !agent ||
      !previewProjects().some((p) => p.id === body.projectId) ||
      !body.name?.trim() ||
      !body.messageTemplate?.trim()
    )
      return HttpResponse.json(
        {
          error: {
            message: "Name, task prompt, agent and project are required",
            type: "api_validation_error",
          },
        },
        { status: 400 },
      );
    const schedule = addPreviewSchedule({
      ...body,
      id: crypto.randomUUID(),
      organizationId: "test-org",
      actorUserId: "test-user-admin",
      createdAt: new Date().toISOString(),
      lastExecutedAt: null,
      agent: { id: agent.id, name: agent.name, agentType: "agent" },
    });
    return HttpResponse.json(schedule, { status: 201 });
  }),
  http.get("/api/agent-catalog", ({ request }) => {
    const q = new URL(request.url).searchParams;
    const list =
      q.get("pinned") === "true"
        ? []
        : agents.filter(
            (a) =>
              (!q.get("name") ||
                a.name.toLowerCase().includes(q.get("name")!.toLowerCase())) &&
              (!q.get("ids") || q.get("ids")!.split(",").includes(a.id)),
          );
    return HttpResponse.json(makeAgentCatalog({ agents: list }));
  }),
  http.get("/api/agents", () => HttpResponse.json(makeAgentsList({ agents }))),
  http.get("/api/agents/:id", ({ params }) =>
    HttpResponse.json(agents.find((a) => a.id === params.id) ?? agents[0]),
  ),
  http.get("/api/projects", () =>
    HttpResponse.json(page(previewProjects().map((p) => project(p.id)))),
  ),
  http.post("/api/projects", async ({ request }) => {
    const body = (await request.json()) as {
      name: string;
      defaultAgentId?: string;
    };
    if (!body.name?.trim())
      return HttpResponse.json(
        {
          error: {
            message: "Project name is required",
            type: "api_validation_error",
          },
        },
        { status: 400 },
      );
    const added = addPreviewProject({
      id: crypto.randomUUID(),
      name: body.name.trim(),
      defaultAgentId: body.defaultAgentId ?? null,
    });
    return HttpResponse.json(project(added.id), { status: 201 });
  }),
  http.get("/api/projects/:id", ({ params }) =>
    HttpResponse.json(project(String(params.id))),
  ),
  http.get("/api/projects/:id/conversations", ({ params }) =>
    HttpResponse.json(
      previewSchedules()
        .filter((s) => s.projectId === params.id)
        .flatMap((s) => syntheticRuns(s.id))
        .map((r) => conversation(r.chatConversationId!)),
    ),
  ),
  http.get("/api/projects/:id/runs", () => HttpResponse.json([])),
  http.get("/api/projects/:id/files", () => HttpResponse.json([])),
  http.get("/api/projects/:id/instructions", () =>
    HttpResponse.json({ content: "", updatedAt: null }),
  ),
];
