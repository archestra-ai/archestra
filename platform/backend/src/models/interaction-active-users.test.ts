import InteractionModel from "@/models/interaction";
import { expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";

test("active-user windows count each attributed user once in one statement", async ({
  makeAgent,
  makeUser,
  makeInteraction,
}) => {
  const agent = await makeAgent();
  const recent = await makeUser();
  const earlier = await makeUser();
  const expired = await makeUser();
  const day = new Date("2026-01-07T00:00:00Z");
  const week = new Date("2026-01-01T00:00:00Z");
  for (const [userId, createdAt] of [
    [recent.id, day],
    [recent.id, week],
    [earlier.id, week],
    [expired.id, new Date(week.getTime() - 1)],
    [null, day],
  ] as const)
    await makeInteraction(agent.id, { userId, createdAt });
  const measured = await recordQueries(() =>
    InteractionModel.countDistinctActiveUsersForWindows([day, week, day]),
  );
  expect(measured.result).toEqual([1, 2, 1]);
  expect(measured.statements).toHaveLength(1);
  expect(await InteractionModel.countDistinctActiveUsersForWindows([])).toEqual(
    [],
  );
  expect(
    await InteractionModel.countDistinctActiveUsersForWindows([
      new Date("2027-01-01"),
    ]),
  ).toEqual([0]);
});
