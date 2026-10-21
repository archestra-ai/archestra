import { describe, expect, test } from "@/test";
import type { InsertInteraction } from "@/types";
import InteractionModel from "./interaction";

describe("InteractionModel log labels", () => {
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

function completion(message: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    object: "chat.completion",
    created: Date.now(),
    model: "gpt-4o",
    choices: [{ index: 0, finish_reason: "stop", logprobs: null, message }],
  };
}
