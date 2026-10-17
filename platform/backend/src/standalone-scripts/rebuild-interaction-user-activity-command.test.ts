import db, { schema } from "@/database";
import InteractionUserActivityModel from "@/models/interaction-user-activity";
import { expect, test } from "@/test";
import {
  parseInteractionUserActivityArguments,
  rebuildInteractionUserActivityCommand,
} from "./rebuild-interaction-user-activity-command";

async function run(args: string[]) {
  return rebuildInteractionUserActivityCommand(
    parseInteractionUserActivityArguments(args),
  );
}

test("invalid CLI arguments reject before invalidation or enablement", async () => {
  const before = await InteractionUserActivityModel.state();
  for (const args of [
    ["--enable", "--disable", "--invalidate"],
    ["--max-batches", "0"],
    ["--max-batches", "1.5"],
    ["--invalidate", "--batch-size", "0"],
    ["--batch-size", "0"],
    ["--batch-size", "1001"],
    ["--unknown"],
  ])
    await expect(run(args)).rejects.toThrow();
  expect(await InteractionUserActivityModel.state()).toEqual(before);
});

test("disabled exits successfully; incomplete exits 2; resume and invalidation rebuild real history", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const users = [await makeUser(), await makeUser(), await makeUser()];
  await db.insert(schema.interactionsTable).values(
    users.map((user) => ({
      userId: user.id,
      profileId: agent.id,
      type: "openai:chatCompletions" as const,
      request: { model: "synthetic", messages: [] },
      response: {
        id: "synthetic",
        object: "chat.completion" as const,
        created: 0,
        model: "synthetic",
        choices: [],
      },
    })),
  );
  expect(await run([])).toBe(0);
  expect((await InteractionUserActivityModel.state()).enabled).toBe(false);
  expect(
    await run(["--enable", "--batch-size", "1", "--max-batches", "1"]),
  ).toBe(2);
  const initial = await InteractionUserActivityModel.state();
  expect(initial.ready).toBe(false);
  expect(await run(["--batch-size", "1"])).toBe(0);
  expect((await InteractionUserActivityModel.state()).generation).toBe(
    initial.generation,
  );
  expect(
    await db.select().from(schema.interactionUserActivityTable),
  ).toHaveLength(3);
  expect(await run(["--invalidate"])).toBe(0);
  expect((await InteractionUserActivityModel.state()).generation).toBe(
    initial.generation + 1,
  );
  expect(
    await db.select().from(schema.interactionUserActivityTable),
  ).toHaveLength(3);
  expect(await run(["--disable"])).toBe(0);
  expect((await InteractionUserActivityModel.state()).ready).toBe(false);
});
