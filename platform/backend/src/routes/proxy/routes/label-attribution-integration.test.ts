import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import { VirtualApiKeyLabelModel } from "@/models/entity-labels";
import ModelModel from "@/models/model";
import TeamLabelModel from "@/models/team-label";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { expect, onTestFinished, test } from "@/test";
import openAiProxyRoutes from "./openai";

test.for([
  "buffered",
  "streaming",
  "without usage",
  "upstream failure",
])("snapshots trusted labels before the upstream call: %s", async (mode, {
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id);
  const team = await makeTeam(org.id, user.id);
  const agent = await makeAgent({ organizationId: org.id });
  const key = await VirtualApiKeyModel.create({
    organizationId: org.id,
    name: "Test application",
    keyType: "passthrough",
    authorId: user.id,
    scope: "personal",
    billingTeamId: team.id,
  });
  await VirtualApiKeyLabelModel.syncLabels(key.virtualKey.id, [
    { key: "app", value: "search" },
  ]);
  await TeamLabelModel.syncTeamLabels(team.id, [
    { key: "cost_center", value: "C100" },
  ]);
  await ModelModel.create({
    provider: "openai",
    modelId: "gpt-4o",
    externalId: "openai/gpt-4o",
    customPricePerMillionInput: "1",
    customPricePerMillionOutput: "2",
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  // A real loopback transport exercises SDK stream cancellation when the
  // proxy stops at the trailing usage frame, before the upstream [DONE].
  const upstream = createServer(async (request, response) => {
    request.resume();
    await TeamLabelModel.syncTeamLabels(team.id, [
      { key: "cost_center", value: "C200" },
    ]);
    response.setHeader(
      "content-type",
      mode === "streaming" || mode === "without usage"
        ? "text/event-stream"
        : "application/json",
    );
    if (mode === "upstream failure") {
      response.writeHead(400);
      response.end(
        JSON.stringify({
          error: {
            message: "Invalid test request",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (mode === "buffered") {
      response.end(
        JSON.stringify({
          id: "chatcmpl-labels",
          object: "chat.completion",
          created: 1,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Local test" },
              finish_reason: "stop",
            },
          ],
          usage,
        }),
      );
      return;
    }
    const chunk = {
      id: "chatcmpl-labels",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
    };
    const events = [
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Local test" },
            finish_reason: null,
          },
        ],
      },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ...(mode === "without usage" ? [] : [{ ...chunk, choices: [], usage }]),
    ];
    response.end(
      `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("No local upstream address");
  config.llm.openai.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const app = createFastifyInstance();
  onTestFinished(async () => {
    upstream.closeAllConnections();
    upstream.close();
    await app.close();
  });
  await app.register(openAiProxyRoutes);
  const response = await app.inject({
    method: "POST",
    url: `/v1/openai/${agent.id}/chat/completions`,
    headers: {
      authorization: "Bearer local-provider-key",
      "x-archestra-virtual-key": key.value,
    },
    payload: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      stream: mode === "streaming" || mode === "without usage",
      metadata: { cost_center: "spoofed" },
    },
  });
  expect(response.statusCode, response.body).toBe(
    mode === "upstream failure" ? 400 : 200,
  );
  const rows = await db
    .select()
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.profileId, agent.id));
  expect(rows).toHaveLength(1);
  expect(rows[0].attributionLabels).toEqual({
    app: "search",
    cost_center: "C100",
  });
  expect(rows[0].billingTeamId).toBe(team.id);
  expect(rows[0].passthroughVirtualKeyId).toBe(key.virtualKey.id);
});
