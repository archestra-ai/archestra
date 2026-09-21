import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
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
