import { describe, expect, test } from "@/test";
import type { InsertInteraction } from "@/types";
import InteractionModel from "./interaction";

describe("InteractionModel log labels", () => {
  test("selects the displayed request and its labels within the organization's session scope", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const agent = await makeAgent({ organizationId: organization.id });
    const otherAgent = await makeAgent({
      organizationId: otherOrganization.id,
    });
    const user = await makeUser();
    const sessionId = `shared-session-${crypto.randomUUID()}`;
    const own = await InteractionModel.create({
      ...chatTurn({
        profileId: agent.id,
        sessionId,
        prompt: "This organization's captured request",
      }),
      createdAt: new Date("2026-01-01T12:00:00Z"),
      attributionLabels: { cost_center: "OWN" },
    });
    await InteractionModel.create({
      ...chatTurn({
        profileId: otherAgent.id,
        sessionId,
        prompt: "Another organization's newer request",
      }),
      createdAt: new Date("2026-01-01T12:01:00Z"),
      attributionLabels: { cost_center: "OTHER" },
    });
    const sessions = await InteractionModel.getSessions(
      { limit: 10, offset: 0 },
      user.id,
      true,
      { sessionId, organizationId: organization.id },
    );
    expect(sessions.data).toHaveLength(1);
    expect(sessions.data[0]).toMatchObject({
      lastInteractionId: own.id,
      attributionLabels: { cost_center: "OWN" },
    });
  });

  test("returns each request's captured labels and only the displayed request's labels on a session row", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({ organizationId: organization.id });
    const user = await makeUser();
    const sessionId = `attribution-${crypto.randomUUID()}`;
    const first = await InteractionModel.create({
      ...chatTurn({
        profileId: agent.id,
        sessionId,
        prompt: "First request in a billing session",
      }),
      createdAt: new Date("2026-01-01T12:00:00Z"),
      attributionLabels: { cost_center: "C100", application: "search" },
    });
    const last = await InteractionModel.create({
      ...chatTurn({
        profileId: agent.id,
        sessionId,
        prompt: "Later request after the cost center changed",
      }),
      createdAt: new Date("2026-01-01T12:01:00Z"),
      attributionLabels: { cost_center: "C200" },
    });
    const requests = await InteractionModel.findSummariesPaginated({
      pagination: { limit: 10, offset: 0 },
      filters: { sessionId, organizationId: organization.id },
    });
    expect(
      requests.data.find((row) => row.id === first.id)?.attributionLabels,
    ).toEqual({ cost_center: "C100", application: "search" });
    expect(
      requests.data.find((row) => row.id === last.id)?.attributionLabels,
    ).toEqual({ cost_center: "C200" });
    const sessions = await InteractionModel.getSessions(
      { limit: 10, offset: 0 },
      user.id,
      true,
      { sessionId, organizationId: organization.id },
    );
    expect(sessions.data[0]).toMatchObject({
      lastInteractionId: last.id,
      attributionLabels: { cost_center: "C200" },
    });
  });

  test("names each request in a session by the prompt it served", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const sessionId = `labels-${crypto.randomUUID()}`;
    for (const prompt of ["fix the lint errors", "now run the tests"]) {
      await InteractionModel.create(
        chatTurn({ profileId: agent.id, sessionId, prompt }),
      );
    }

    const summaries = await InteractionModel.findSummariesPaginated({
      pagination: { limit: 10, offset: 0 },
      filters: { sessionId },
    });

    expect(
      new Set(summaries.data.map((row) => row.userMessagePreview)),
    ).toEqual(new Set(["fix the lint errors", "now run the tests"]));
  });

  test("tells apart the requests one prompt drives by what each produced", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const sessionId = `steps-${crypto.randomUUID()}`;
    const prompt = "find the flaky test";
    await InteractionModel.create({
      ...chatTurn({ profileId: agent.id, sessionId, prompt }),
      response: completion({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "Grep", arguments: "{}" },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "Read", arguments: "{}" },
          },
        ],
      }),
    });
    await InteractionModel.create({
      ...chatTurn({ profileId: agent.id, sessionId, prompt }),
      response: completion({
        role: "assistant",
        content: "The retry reuses a stale idempotency key.",
      }),
    });

    const summaries = await InteractionModel.findSummariesPaginated({
      pagination: { limit: 10, offset: 0 },
      filters: { sessionId },
    });

    expect(
      summaries.data.map((row) => ({
        prompt: row.userMessagePreview,
        tools: row.responseToolNames,
        reply: row.responseTextPreview,
      })),
    ).toEqual(
      expect.arrayContaining([
        { prompt, tools: ["Grep", "Read"], reply: null },
        {
          prompt,
          tools: [],
          reply: "The retry reuses a stale idempotency key.",
        },
      ]),
    );
  });

  test("names a session by its knowledge connector when it has just one", async ({
    makeAdmin,
    makeAgent,
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const admin = await makeAdmin();
    const org = await makeOrganization();
    const agent = await makeAgent();
    const kb = await makeKnowledgeBase(org.id);
    const github = await makeKnowledgeBaseConnector(kb.id, org.id, {
      name: "GitHub · platform",
    });
    const confluence = await makeKnowledgeBaseConnector(kb.id, org.id, {
      name: "Confluence · ENG",
    });

    const single = `kb-single-${crypto.randomUUID()}`;
    const mixed = `kb-mixed-${crypto.randomUUID()}`;
    for (const [sessionId, connectorId] of [
      [single, github.id],
      [single, github.id],
      [mixed, github.id],
      [mixed, confluence.id],
    ] as const) {
      await InteractionModel.create({
        ...chatTurn({ profileId: agent.id, sessionId, prompt: "embed" }),
        connectorId,
      });
    }

    const nameOf = async (sessionId: string) => {
      const sessions = await InteractionModel.getSessions(
        { limit: 10, offset: 0 },
        admin.id,
        true,
        { sessionId },
      );
      return sessions.data[0]?.connectorName;
    };

    expect(await nameOf(single)).toBe("GitHub · platform");
    // Two connectors share no one name, so the list keeps its generic label.
    expect(await nameOf(mixed)).toBeNull();
  });
});

function chatTurn(params: {
  profileId: string;
  sessionId: string;
  prompt: string;
}): InsertInteraction {
  return {
    profileId: params.profileId,
    sessionId: params.sessionId,
    type: "openai:chatCompletions",
    request: {
      model: "gpt-4o",
      messages: [{ role: "user", content: params.prompt }],
    },
    response: {
      id: crypto.randomUUID(),
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4o",
      choices: [],
    },
  } as InsertInteraction;
}

function completion(
  message: Record<string, unknown>,
): InsertInteraction["response"] {
  return {
    id: crypto.randomUUID(),
    object: "chat.completion",
    created: Date.now(),
    model: "gpt-4o",
    choices: [{ index: 0, finish_reason: "stop", logprobs: null, message }],
  } as InsertInteraction["response"];
}
