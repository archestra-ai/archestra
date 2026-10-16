import {
  BUILT_IN_AGENT_IDS,
  SESSION_ID_HEADER,
  SOURCE_HEADER,
  USER_ID_HEADER,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http, passthrough } from "msw";
import { takeInternalCall } from "@/clients/internal-call";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
import { openappaActor } from "@/openappa/actor";
import { openappaDeclarations } from "@/openappa/declarations";
import { OPENAPPA_CONTEXT_HEADER } from "@/openappa/encrypted-chat";
import { withOpenappaReplayOwner } from "@/openappa/replay-owner";
import { OPENAPPA_ARCHESTRA_ANNOTATOR_PATH } from "@/routes/route-paths";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import routes from "./openappa-archestra-annotator.routes";

const request = {
  system: "Label the command's trust.",
  input: '{"tool":"archestra__run_command","arguments":{"command":"ls"}}',
  schema: {
    type: "object",
    properties: { rank: { type: "string", enum: ["suspicious", "trusted"] } },
    required: ["rank"],
    additionalProperties: false,
  },
};

describe("archestra annotator", () => {
  const server = useMswServer();
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let agentId: string;
  let useDefaultModel: (params: {
    provider: "openai" | "openrouter";
    modelId: string;
    organizationId?: string;
  }) => Promise<void>;

  beforeEach(
    async ({
      makeOrganization,
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      config.openappa.enabled = true;
      organizationId = (await makeOrganization()).id;
      agentId = (
        await makeAgent({
          organizationId,
          agentType: "agent",
          builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
        })
      ).id;
      app = createFastifyInstance();
      await app.register(routes);
      useDefaultModel = async (params) => {
        const orgId = params.organizationId ?? organizationId;
        const secret = await makeSecret({ secret: { apiKey: "provider-key" } });
        const key = await makeLlmProviderApiKey(orgId, secret.id, {
          provider: params.provider,
          name: "Provider",
        });
        const model = await ModelModel.create({
          externalId: `${params.provider}/${params.modelId}`,
          provider: params.provider,
          modelId: params.modelId,
          contextLength: 128_000,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalling: true,
          lastSyncedAt: new Date(),
        });
        await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
          model.id,
        ]);
        await db
          .update(schema.organizationsTable)
          .set({ defaultModelId: model.id, defaultLlmApiKeyId: key.id })
          .where(eq(schema.organizationsTable.id, orgId));
      };
    },
  );
  afterEach(async () => {
    await app.close();
  });

  const annotate = (authorization?: string, payload: object = request) =>
    app.inject({
      method: "POST",
      url: OPENAPPA_ARCHESTRA_ANNOTATOR_PATH,
      headers: authorization === undefined ? {} : { authorization },
      remoteAddress: "127.0.0.1",
      payload,
    });
  const bearer = () => `Bearer ${openappaDeclarations.bridgeToken}`;

  test("refuses a caller without the bridge bearer", async () => {
    expect((await annotate()).statusCode).toBe(401);
    expect((await annotate("Bearer not-the-bridge-token")).statusCode).toBe(
      401,
    );
  });

  type SentRequest = {
    body: Record<string, unknown>;
    source: string | null;
    internal: boolean;
    user: string | null;
    session: string | null;
  };
  const answerAt = (
    path: string,
    answer: (body: Record<string, unknown>) => Response,
  ): SentRequest[] => {
    const sent: SentRequest[] = [];
    server.use(
      http.post(
        `http://127.0.0.1:${config.api.port}${path}`,
        async ({ request: proxied }) => {
          const body = (await proxied.json()) as Record<string, unknown>;
          sent.push({
            body,
            source: proxied.headers.get(SOURCE_HEADER),
            internal: takeInternalCall(Object.fromEntries(proxied.headers)),
            user: proxied.headers.get(USER_ID_HEADER),
            session: proxied.headers.get(SESSION_ID_HEADER),
          });
          return answer(body);
        },
      ),
    );
    return sent;
  };
  const completion = (content: string) =>
    HttpResponse.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  const systemOf = (body: Record<string, unknown>) =>
    (body.messages as Array<{ role: string; content: unknown }>)[0];

  test("answers under the provider's structured-output format, through the LLM proxy", async () => {
    await useDefaultModel({
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
    const sent = answerAt(`/v1/openai/${agentId}/chat/completions`, () =>
      completion('{"rank":"trusted"}'),
    );

    const response = await annotate(bearer());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rank: "trusted" });
    expect(sent).toHaveLength(1);
    const [{ body, source, internal }] = sent;
    expect(body).toMatchObject({
      model: "gpt-4o-mini",
      response_format: {
        type: "json_schema",
        json_schema: { schema: request.schema },
      },
    });
    expect(body).not.toHaveProperty("temperature");
    // The catalog has no output cap for this model, so the provider's default
    // stands and a long prompt keeps whatever window it leaves.
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(source).toBe("guardrail:annotator");
    expect(internal).toBe(true);
  });

  test("falls back to a tagged answer for a model that refuses the format, and stops asking it", async () => {
    await useDefaultModel({
      provider: "openai",
      modelId: "gpt-refuses-schemas",
    });
    const sent = answerAt(`/v1/openai/${agentId}/chat/completions`, (body) =>
      "response_format" in body
        ? HttpResponse.json(
            { error: { message: "Invalid schema.", type: "invalid_request" } },
            { status: 400 },
          )
        : completion('<annotation>{"rank":"suspicious"}</annotation>'),
    );

    const first = await annotate(bearer());
    const second = await annotate(bearer());

    expect(first.json()).toEqual({ rank: "suspicious" });
    expect(second.json()).toEqual({ rank: "suspicious" });
    expect(sent.map(({ body }) => "response_format" in body)).toEqual([
      true,
      false,
      false,
    ]);
    // The tagged prompt extends the structured one, schema included.
    const [structured, tagged] = sent.map(
      ({ body }) => systemOf(body).content as string,
    );
    expect(tagged.startsWith(structured)).toBe(true);
  });

  test("does not blame the format for a request the tagged answer rejects too", async () => {
    await useDefaultModel({ provider: "openai", modelId: "gpt-4o-mini" });
    let calls = 0;
    const sent = answerAt(`/v1/openai/${agentId}/chat/completions`, () =>
      calls++ < 2
        ? HttpResponse.json(
            { error: { message: "Input too long.", type: "invalid_request" } },
            { status: 400 },
          )
        : completion('{"rank":"trusted"}'),
    );

    const first = await annotate(bearer());
    const second = await annotate(bearer());

    expect(first.statusCode).toBe(502);
    expect(second.json()).toEqual({ rank: "trusted" });
    expect(sent.map(({ body }) => "response_format" in body)).toEqual([
      true,
      false,
      true,
    ]);
  });

  test("skips the format only once its answers keep falling outside the schema", async () => {
    await useDefaultModel({
      provider: "openai",
      modelId: "gpt-answers-in-prose",
    });
    const structuredReplies = [
      "not json",
      '{"rank":"trusted"}',
      "not json",
      "not json",
    ];
    const sent = answerAt(`/v1/openai/${agentId}/chat/completions`, (body) =>
      "response_format" in body
        ? completion(structuredReplies.shift() ?? "unexpected")
        : completion('<annotation>{"rank":"suspicious"}</annotation>'),
    );

    const answers = [];
    for (let consult = 0; consult < 5; consult++)
      answers.push((await annotate(bearer())).json());

    expect(answers.map((answer) => answer.rank)).toEqual([
      "suspicious",
      "trusted",
      "suspicious",
      "suspicious",
      "suspicious",
    ]);
    // A structured answer clears the first miss; two in a row skip the format.
    expect(sent.map(({ body }) => "response_format" in body)).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
      false,
      false,
    ]);
  });

  test("marks the constant system prompt as a cache breakpoint for Claude through OpenRouter", async () => {
    await useDefaultModel({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5",
    });
    const sent = answerAt(`/v1/openrouter/${agentId}/chat/completions`, () =>
      completion('{"rank":"trusted"}'),
    );

    const response = await annotate(bearer());

    expect(response.json()).toEqual({ rank: "trusted" });
    expect(systemOf(sent[0].body)).toMatchObject({
      role: "system",
      cache_control: { type: "ephemeral" },
    });
  });

  const ROOT = "archestra:root";
  const openSession = (params: {
    organizationId: string;
    callerId: string;
    sessionId: string;
    parentId?: string;
    root?: string;
  }) =>
    db.insert(schema.openappaSessionsTable).values({
      root: ROOT,
      ...params,
      actor: openappaActor(params.sessionId),
      startDecision: { decision: "ack" },
    });

  test("files an attributed consult under its session's organization, user and session", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const owner = (await makeOrganization()).id;
    const ownerAgent = await makeAgent({
      organizationId: owner,
      agentType: "agent",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
    });
    await useDefaultModel({
      provider: "openai",
      modelId: "gpt-4o-mini",
      organizationId: owner,
    });
    const user = await makeUser();
    await makeMember(user.id, owner);
    const root = `user:${user.id}|conversation`;
    const child = `${root}:subagent`;
    await openSession({
      organizationId: owner,
      callerId: `user:${user.id}`,
      sessionId: root,
    });
    await openSession({
      organizationId: owner,
      callerId: `user:${user.id}`,
      sessionId: child,
      parentId: root,
    });
    const serviceRoot = "archestra:service-account-root";
    await openSession({
      organizationId: owner,
      callerId: "user:service-account:sa-1",
      sessionId: "user:service-account:sa-1|batch",
      root: serviceRoot,
    });
    const sent = answerAt(`/v1/openai/${ownerAgent.id}/chat/completions`, () =>
      completion('{"rank":"trusted"}'),
    );

    const fromRoot = await annotate(bearer(), {
      ...request,
      attribution: { root: ROOT, trajectory: ROOT, call_id: "toolu_1" },
    });
    const fromChild = await annotate(bearer(), {
      ...request,
      attribution: { root: ROOT, trajectory: openappaActor(child) },
    });
    const fromServiceAccount = await annotate(bearer(), {
      ...request,
      attribution: { root: serviceRoot, trajectory: serviceRoot },
    });

    expect(fromRoot.json()).toEqual({ rank: "trusted" });
    expect(fromChild.json()).toEqual({ rank: "trusted" });
    expect(fromServiceAccount.json()).toEqual({ rank: "trusted" });
    expect(sent.map(({ user, session }) => ({ user, session }))).toEqual([
      { user: user.id, session: "conversation" },
      { user: user.id, session: "conversation:subagent" },
      // A service account has no users row; its session still names the call.
      { user: null, session: "batch" },
    ]);
  });

  test("files a validation replay's consult under the organization and user running it, only while it runs", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    // Not the first organization, which an unattributed consult would use.
    const owner = (await makeOrganization()).id;
    const ownerAgent = await makeAgent({
      organizationId: owner,
      agentType: "agent",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
    });
    await useDefaultModel({
      provider: "openai",
      modelId: "gpt-4o-mini",
      organizationId: owner,
    });
    const user = await makeUser();
    await makeMember(user.id, owner);
    const sent = answerAt(`/v1/openai/${ownerAgent.id}/chat/completions`, () =>
      completion('{"rank":"trusted"}'),
    );
    // Replay trajectories live in memory: no session row matches them.
    const replayed = {
      root: "archestra:replay",
      trajectory: "archestra:replay",
    };
    const ask = (context: string) =>
      app.inject({
        method: "POST",
        url: OPENAPPA_ARCHESTRA_ANNOTATOR_PATH,
        headers: {
          authorization: bearer(),
          [OPENAPPA_CONTEXT_HEADER]: context,
        },
        remoteAddress: "127.0.0.1",
        payload: { ...request, attribution: replayed },
      });

    let capability = "";
    const answered = await withOpenappaReplayOwner(
      { organizationId: owner, userId: user.id },
      (context) => {
        capability = context;
        return ask(context);
      },
    );

    expect(answered.json()).toEqual({ rank: "trusted" });
    expect(sent.map(({ user, session }) => ({ user, session }))).toEqual([
      { user: user.id, session: null },
    ]);
    // A settled replay's capability names no one.
    expect((await ask(capability)).statusCode).toBe(401);
  });

  test("answers unattributed when the attribution names no single session, and without a user who left the organization", async ({
    makeUser,
    makeOrganization,
  }) => {
    await useDefaultModel({
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
    const outsider = await makeUser();
    await openSession({
      organizationId,
      callerId: `user:${outsider.id}`,
      sessionId: `user:${outsider.id}|conversation`,
    });
    // Two organizations' rows under one root name no single owner.
    const shared = "archestra:shared-root";
    const other = (await makeOrganization()).id;
    for (const owner of [organizationId, other])
      await openSession({
        organizationId: owner,
        callerId: "app:shared",
        sessionId: "app:shared|conversation",
        root: shared,
      });
    const sent = answerAt(`/v1/openai/${agentId}/chat/completions`, () =>
      completion('{"rank":"trusted"}'),
    );

    const unknown = await annotate(bearer(), {
      ...request,
      attribution: {
        root: "archestra:unknown",
        trajectory: "archestra:unknown",
      },
    });
    const ambiguous = await annotate(bearer(), {
      ...request,
      attribution: { root: shared, trajectory: shared },
    });
    const outside = await annotate(bearer(), {
      ...request,
      attribution: { root: ROOT, trajectory: ROOT },
    });

    expect(unknown.json()).toEqual({ rank: "trusted" });
    expect(ambiguous.json()).toEqual({ rank: "trusted" });
    expect(outside.json()).toEqual({ rank: "trusted" });
    expect(sent.map(({ user, session }) => ({ user, session }))).toEqual([
      { user: null, session: null },
      { user: null, session: null },
      { user: null, session: "conversation" },
    ]);
  });

  test("names the key and the upstream rejection when the model call fails", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "openai-key" } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      name: "Revoked OpenAI",
    });
    const model = await ModelModel.create({
      externalId: "openai/gpt-4o-mini",
      provider: "openai",
      modelId: "gpt-4o-mini",
      contextLength: 128_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    await db
      .update(schema.organizationsTable)
      .set({ defaultModelId: model.id, defaultLlmApiKeyId: key.id })
      .where(eq(schema.organizationsTable.id, organizationId));
    server.use(
      http.post(
        `http://127.0.0.1:${config.api.port}/v1/openai/${agentId}/chat/completions`,
        () =>
          HttpResponse.json(
            {
              error: {
                message: "API key is invalid.",
                type: "authentication_error",
              },
            },
            { status: 401 },
          ),
      ),
    );

    const response = await annotate(bearer());

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toBe(
      `The model call failed: openai/gpt-4o-mini with key "Revoked OpenAI" (${key.id}) was rejected upstream with 401: API key is invalid.`,
    );
  });

  test("cancels its LLM proxy call when the runtime hangs up", async () => {
    await useDefaultModel({ provider: "openai", modelId: "gpt-4o-mini" });
    let reach = () => {};
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    let abort = () => {};
    const upstreamAborted = new Promise<void>((resolve) => {
      abort = resolve;
    });
    server.use(
      http.post(
        `http://127.0.0.1:${config.api.port}/v1/openai/${agentId}/chat/completions`,
        ({ request: proxied }) => {
          reach();
          return new Promise<Response>((_, reject) =>
            proxied.signal.addEventListener("abort", () => {
              abort();
              reject(proxied.signal.reason);
            }),
          );
        },
      ),
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `${address}${OPENAPPA_ARCHESTRA_ANNOTATOR_PATH}`;
    server.use(http.post(url, () => passthrough()));

    const runtime = new AbortController();
    const consult = fetch(url, {
      method: "POST",
      headers: { authorization: bearer(), "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: runtime.signal,
    }).catch(() => null);
    await reached;
    runtime.abort();

    await upstreamAborted;
    expect(await consult).toBeNull();
  });

  test("refuses without a call when no LLM key is configured", async () => {
    // Ignore credentials inherited from a developer's .env.
    for (const entry of Object.values(config.chat)) {
      if (entry && typeof entry === "object" && "apiKey" in entry)
        entry.apiKey = "";
    }
    // Every request is answered by MSW; an unhandled one fails the test.
    const response = await annotate(bearer());
    expect(response.statusCode).toBe(409);
  });
});
