import { expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import AgentModel from "./agent";
import InteractionModel from "./interaction";

test("cursor pages preserve all-owner organization fences, user filters, and deleted-owner history", async ({
  makeOrganization,
  makeAgent,
  makeApp,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
  makeUser,
}) => {
  const org = await makeOrganization();
  const other = await makeOrganization();
  const user = await makeUser();
  const otherUser = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const deleted = await makeAgent({ organizationId: org.id });
  const foreign = await makeAgent({ organizationId: other.id });
  const app = await makeApp({ organizationId: org.id });
  const foreignApp = await makeApp({ organizationId: other.id });
  const kb = await makeKnowledgeBase(org.id);
  const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
  const foreignKb = await makeKnowledgeBase(other.id);
  const foreignConnector = await makeKnowledgeBaseConnector(
    foreignKb.id,
    other.id,
  );
  const ownerships = [
    { profileId: agent.id },
    { profileId: null, appId: app.id },
    { profileId: null, connectorId: connector.id },
    { profileId: agent.id, appId: app.id, connectorId: connector.id },
    { profileId: deleted.id },
    { profileId: foreign.id },
    { profileId: agent.id, appId: foreignApp.id },
    { profileId: foreign.id, appId: app.id },
    { profileId: agent.id, connectorId: foreignConnector.id },
    { profileId: null, connectorId: connector.id, appId: foreignApp.id },
    { profileId: null },
    { profileId: agent.id, userId: otherUser.id },
  ];
  const expected: string[] = [];
  const now = Date.now();
  for (const [index, ownership] of ownerships.entries()) {
    const row = await InteractionModel.create({
      userId: user.id,
      ...ownership,
      type: "openai:chatCompletions",
      createdAt: new Date(now - index * 1000),
      request: { model: "example", messages: [] },
      response: {
        id: "example",
        object: "chat.completion",
        created: 0,
        model: "example",
        choices: [],
      },
    });
    if (index < 5) expected.push(row.id);
  }
  await drainBackgroundWork();
  await AgentModel.delete(deleted.id);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const result = await InteractionModel.getSessionsCursor(
      { limit: 2, cursor },
      undefined,
      undefined,
      { organizationId: org.id, userId: user.id },
    );
    seen.push(...result.data.map((row) => row.interactionId as string));
    if (!result.pagination.hasNext) break;
    expect(result.pagination.nextCursor).toBeTruthy();
    cursor = result.pagination.nextCursor ?? undefined;
  }
  expect(seen).toEqual(expected);
});

test("a newer foreign-owner sibling still prevents an older local row from becoming the session head", async ({
  makeOrganization,
  makeAgent,
  makeInteraction,
}) => {
  const org = await makeOrganization();
  const other = await makeOrganization();
  const localAgent = await makeAgent({ organizationId: org.id });
  const foreignAgent = await makeAgent({ organizationId: other.id });
  const now = Date.now();
  await makeInteraction(localAgent.id, {
    sessionId: "mixed-session",
    createdAt: new Date(now - 1000),
  });
  await makeInteraction(foreignAgent.id, {
    sessionId: "mixed-session",
    createdAt: new Date(now),
  });
  const visible = await makeInteraction(localAgent.id, {
    createdAt: new Date(now - 2000),
  });
  const result = await InteractionModel.getSessionsCursor(
    { limit: 10 },
    undefined,
    undefined,
    { organizationId: org.id },
  );
  expect(result.data.map((row) => row.interactionId)).toEqual([visible.id]);
  expect(result.pagination.hasNext).toBe(false);
});
