import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import { expect, test } from "@/test";
import type { InsertInteraction } from "@/types";
import InteractionModel from "./interaction";

const FILE_BODY = Buffer.from("private attachment bytes").toString("base64");
const DATA_URL = `data:image/png;base64,${FILE_BODY}`;
const REMOTE_URL = "https://example.com/image.png";
const TEXT = "Describe the attachment";

const cases: Array<Pick<InsertInteraction, "type" | "request" | "response">> = [
  {
    type: "openai:chatCompletions",
    request: {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: TEXT },
            { type: "image_url", image_url: { url: DATA_URL } },
            { type: "image_url", image_url: { url: REMOTE_URL } },
            {
              type: "file",
              file: { filename: "report.pdf", file_data: FILE_BODY },
            },
            {
              type: "input_audio",
              input_audio: { format: "wav", data: FILE_BODY },
            },
          ],
        },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "start-direct",
              type: "function",
              function: {
                name: "archestra__start_run",
                arguments: JSON.stringify({
                  agent_id: "test-agent",
                  message: TEXT,
                  attachments: [
                    { filename: "report.pdf", contentBase64: FILE_BODY },
                  ],
                }),
              },
            },
            {
              id: "start-wrapped",
              type: "function",
              function: {
                name: "archestra__run_tool",
                arguments: JSON.stringify({
                  tool_name: "archestra__start_run",
                  tool_args: {
                    agent_id: "test-agent",
                    message: TEXT,
                    attachments: [
                      { filename: "report.pdf", contentBase64: FILE_BODY },
                    ],
                  },
                }),
              },
            },
          ],
        },
      ],
    },
    response: { error: "Provider unavailable" },
  },
  {
    type: "ollama-native:chat",
    request: {
      model: "gemma3",
      messages: [{ role: "user", content: TEXT, images: [FILE_BODY] }],
    },
    response: { error: "Provider unavailable" },
  },
  {
    type: "openai:responses",
    request: {
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: TEXT },
            { type: "input_image", image_url: DATA_URL },
            {
              type: "input_file",
              filename: "report.pdf",
              file_data: FILE_BODY,
            },
          ],
        },
      ],
    },
    response: { error: "Provider unavailable" },
  },
  {
    type: "anthropic:messages",
    request: {
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: TEXT },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: FILE_BODY,
              },
            },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: FILE_BODY,
              },
            },
            {
              type: "document",
              source: {
                type: "text",
                media_type: "text/plain",
                data: FILE_BODY,
              },
            },
          ],
        },
      ],
    },
    response: { error: "Provider unavailable" },
  },
  {
    type: "gemini:generateContent",
    request: {
      contents: [
        {
          role: "user",
          parts: [
            { text: TEXT },
            { inlineData: { mimeType: "image/png", data: FILE_BODY } },
            { inlineData: { mimeType: "application/pdf", data: FILE_BODY } },
          ],
        },
      ],
    },
    response: {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [
              { text: "Generated image" },
              { inlineData: { mimeType: "image/png", data: FILE_BODY } },
              {
                functionCall: {
                  name: "archestra__run_tool",
                  args: {
                    tool_name: "archestra__post_run_file",
                    tool_args: {
                      filename: "report.pdf",
                      content_base64: FILE_BODY,
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  },
  {
    type: "bedrock:converse",
    request: {
      modelId: "anthropic.claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: [
            { text: TEXT },
            { image: { format: "png", source: { bytes: FILE_BODY } } },
            {
              document: {
                name: "report",
                format: "pdf",
                source: { bytes: FILE_BODY },
              },
            },
          ],
        },
      ],
    },
    response: { error: "Provider unavailable" },
  },
];

test.for(
  cases,
)("$type omits Slack inline files from persisted audit payloads without changing provider traffic", async (payload, {
  makeAgent,
}) => {
  const agent = await makeAgent();
  const input = {
    ...structuredClone(payload),
    profileId: agent.id,
    source: "chatops:slack" as const,
    processedRequest: structuredClone(payload.request),
    inputTokens: 30,
    outputTokens: 20,
    cost: "0.0010000000",
  };
  const before = structuredClone(input);

  const created = await InteractionModel.create(input);
  const [stored] = await db
    .select()
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.id, created.id));

  for (const request of [stored.request, stored.processedRequest]) {
    expect(JSON.stringify(request)).not.toContain(FILE_BODY);
    expect(JSON.stringify(request)).toContain(TEXT);
    expect(JSON.stringify(request)).toContain("Ephemeral file payload omitted");
  }
  expect(JSON.stringify(stored.response)).not.toContain(FILE_BODY);
  expect(stored).toMatchObject({
    source: "chatops:slack",
    inputTokens: 30,
    outputTokens: 20,
    cost: "0.0010000000",
  });
  expect(input).toEqual(before);
  if (payload.type === "openai:chatCompletions") {
    expect(JSON.stringify(stored.request)).toContain(REMOTE_URL);
    expect(JSON.stringify(stored.request)).toContain("report.pdf");
  }
  if (payload.type === "gemini:generateContent") {
    expect(JSON.stringify(stored.response)).toContain("Generated image");
    expect(JSON.stringify(stored.response)).toContain("image/png");
  }
});

test("other interaction sources retain their file payloads", async ({
  makeAgent,
}) => {
  const agent = await makeAgent();
  const payload = cases.find(
    (entry) => entry.type === "gemini:generateContent",
  );
  if (!payload) throw new Error("Missing Gemini fixture");
  const created = await InteractionModel.create({
    ...payload,
    profileId: agent.id,
    source: "chat",
    processedRequest: payload.request,
  });
  const [stored] = await db
    .select()
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.id, created.id));

  expect(stored.request).toEqual(payload.request);
  expect(stored.processedRequest).toEqual(payload.request);
  expect(stored.response).toEqual(payload.response);
});

test("runtime files are omitted by the authenticated virtual key association, never a run header", async ({
  makeOrganization,
  makeUser,
  makeAgent,
  makeVirtualApiKey,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: organization.id });
  const key = await makeVirtualApiKey(organization.id);
  const unrelatedKey = await makeVirtualApiKey(organization.id);
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  const run = await AgentRunModel.create({
    organizationId: organization.id,
    taskId: task.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: user.id,
    actorUserId: user.id,
    workloadName: `ephemeral-files-${task.id}`,
    backend: "kubernetes",
    runtimeScope: "test",
    virtualApiKeyId: key.id,
    completionTarget: {
      type: "chatops",
      bindingId: crypto.randomUUID(),
      threadId: "123.456",
      ephemeralFiles: true,
    },
  });
  // Final provider writes may settle after the task has finished.
  await AgentRunModel.close({ id: run.id });
  const payload = cases.find(
    (entry) => entry.type === "gemini:generateContent",
  );
  if (!payload) throw new Error("Missing Gemini fixture");
  const before = structuredClone(payload);

  for (const virtualKeyId of [key.id, unrelatedKey.id, undefined]) {
    const created = await InteractionModel.create({
      ...payload,
      profileId: agent.id,
      source: "opencode:main",
      virtualKeyId,
      runId: task.id,
      processedRequest: payload.request,
    });
    const [stored] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, created.id));

    for (const value of [
      stored.request,
      stored.processedRequest,
      stored.response,
    ]) {
      if (virtualKeyId === key.id) {
        expect(JSON.stringify(value)).not.toContain(FILE_BODY);
        expect(JSON.stringify(value)).toContain(
          "Ephemeral file payload omitted",
        );
      } else {
        expect(JSON.stringify(value)).toContain(FILE_BODY);
      }
    }
  }
  expect(payload).toEqual(before);
});
