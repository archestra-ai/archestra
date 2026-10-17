import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import InteractionModel from "./interaction";
import InteractionUserActivityModel from "./interaction-user-activity";

test("attributed append preserves native decimals, dates, nested JSON, defaults and encrypted content", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const user = await makeUser();
  const createdAt = new Date("2026-01-02T03:04:05.678Z");
  const request = {
    model: "synthetic",
    messages: [
      { role: "user" as const, content: "quoted ' JSON and unicode λ" },
    ],
  };
  const response = {
    id: "synthetic",
    object: "chat.completion" as const,
    created: 0,
    model: "synthetic",
    choices: [],
  };
  const audit = { dek: randomBytes(32), conversationId: randomUUID() };
  const created = await InteractionModel.create(
    {
      profileId: agent.id,
      userId: user.id,
      type: "openai:chatCompletions",
      request,
      processedRequest: request,
      response,
      createdAt,
      cost: "999.9999999999",
      baselineCost: "0.1000000000",
      cacheCost: "1.2300000000",
      inputTokensEstimated: true,
      billingMode: "subscription",
    },
    audit,
  );
  expect(created).toMatchObject({
    request,
    processedRequest: request,
    response,
    createdAt,
    cost: "999.9999999999",
    baselineCost: "0.1000000000",
    cacheCost: "1.2300000000",
    inputTokensEstimated: true,
    billingMode: "subscription",
    encryptedChatConversationId: audit.conversationId,
  });
  expect(created.createdAt).toBeInstanceOf(Date);
  const [stored] = await db
    .select()
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.id, created.id));
  expect(stored.request).not.toEqual(request);
  expect(stored.response).not.toEqual(response);
  expect(stored.processedRequest).not.toEqual(request);
  const plain = await InteractionModel.create({
    profileId: agent.id,
    userId: user.id,
    type: "openai:chatCompletions",
    request,
    response,
  });
  expect(plain.request).toEqual(request);
  expect(plain.response).toEqual(response);
  expect(plain.billingMode).toBe("metered");
  expect(plain.inputTokensEstimated).toBe(false);
  expect(plain.createdAt).toBeInstanceOf(Date);
  expect(plain.createdAt.getTime()).toBeGreaterThan(Date.now() - 30_000);
});

test("attributed appends use one atomic statement after environment lookup whether enabled or disabled", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const user = await makeUser();
  for (const enabled of [false, true]) {
    await InteractionUserActivityModel.setEnabled(enabled);
    const measured = await recordQueries(() =>
      InteractionModel.create({
        profileId: agent.id,
        userId: user.id,
        type: "openai:chatCompletions",
        request: { model: "synthetic", messages: [] },
        response: {
          id: "synthetic",
          object: "chat.completion",
          created: 0,
          model: "synthetic",
          choices: [],
        },
      }),
    );
    expect(measured.result.userId).toBe(user.id);
    expect(
      measured.statements.filter(
        (statement) =>
          !(
            /^update "agents" set /i.test(statement) &&
            statement.includes('"last_used_at"')
          ),
      ),
    ).toHaveLength(2);
    expect(measured.statements[1]).toContain(
      "interaction_user_activity_append",
    );
  }
});

test("append rejects unsupported columns and encodings instead of silently discarding fields", async () => {
  await expect(
    db.execute(
      sql`SELECT * FROM interaction_user_activity_append(${JSON.stringify({ id: randomUUID(), unsupported: "value" })}::jsonb)`,
    ),
  ).rejects.toThrow();
  await expect(
    db.execute(
      sql`SELECT * FROM interaction_user_activity_append(${JSON.stringify({ id: randomUUID(), request: { messages: [] } })}::jsonb)`,
    ),
  ).rejects.toThrow();
});

test("a missing append migration fails without writing an uncounted interaction", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const user = await makeUser();
  await db.execute(
    sql`ALTER FUNCTION interaction_user_activity_append(jsonb) RENAME TO interaction_user_activity_append_unavailable`,
  );
  try {
    await expect(
      InteractionModel.create({
        profileId: agent.id,
        userId: user.id,
        type: "openai:chatCompletions",
        request: { model: "synthetic", messages: [] },
        response: {
          id: "synthetic",
          object: "chat.completion",
          created: 0,
          model: "synthetic",
          choices: [],
        },
      }),
    ).rejects.toThrow();
    expect(await db.select().from(schema.interactionsTable)).toHaveLength(0);
  } finally {
    await db.execute(
      sql`ALTER FUNCTION interaction_user_activity_append_unavailable(jsonb) RENAME TO interaction_user_activity_append`,
    );
  }
});
