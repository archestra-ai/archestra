import type { archestraApiTypes } from "@archestra/shared";

type UsageStatistics =
  archestraApiTypes.GetSkillUsageStatisticsResponses["200"];
type UsageActor = UsageStatistics["users"][number];
type DailyBucket = UsageStatistics["daily"][number];

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;

/**
 * A skill an organization actually leans on: dozens of people, a nightly
 * automation on top, and a tail of one-off users — the shape that made the old
 * dialog unreadable and the shape the Usage tab has to stay legible at.
 *
 * Every actor kind appears, because each renders differently: a person, a
 * service account, a user and a service account whose rows are gone, and
 * activations that carried no signed-in user at all.
 */
const NAMES = [
  "Priya Raghunathan",
  "Marcus Oyelaran",
  "Elena Vasquez-Moreau",
  "Tobias Lindqvist",
  "Amara Nwachukwu",
  "Dmitri Sokolov",
  "Yuki Tanaka",
  "Rafael Ortiz",
  "Sinead O'Callaghan",
  "Chen Wei",
  "Fatima Al-Rashid",
  "Bjorn Haugen",
  "Isabella Ferreira",
  "Kwame Asante",
  "Noor Haddad",
  "Lars Van Der Berg",
  "Anjali Deshmukh",
  "Diego Castellanos",
  "Mei-Ling Chow",
  "Oscar Delacroix",
  "Zainab Bello",
  "Henrik Nordstrom",
  "Camila Rojas",
  "Arjun Venkatesan",
  "Freya Andersen",
  "Tomas Kowalski",
  "Leila Farahani",
  "Ndidi Okonkwo",
  "Sebastian Reyes",
  "Hana Kobayashi",
  "Viktor Petrov",
  "Aisha Mensah",
  "Gabriel Santos",
  "Ingrid Bergqvist",
  "Ravi Chandrasekaran",
  "Solveig Dahl",
];

/**
 * Long-tail counts: a couple of heavy users, then a slope down to a crowd of
 * people who ran it once. Deterministic so the demo and any spec built on it
 * see the same chart twice.
 */
function tailedTotal(rank: number): number {
  if (rank === 0) return 41;
  if (rank === 1) return 28;
  return Math.max(1, Math.round(34 / (rank + 1)) + (rank % 3));
}

const people: UsageActor[] = NAMES.map((name, index) => ({
  userId: `demo-user-${index}`,
  name,
  kind: "user" as const,
  total: tailedTotal(index),
}));

export const skillUsageStatisticsSeed: UsageStatistics = buildStatistics([
  // The busiest actor is not a person: a scheduled job runs this skill nightly.
  {
    userId: "service-account:11111111-1111-4111-8111-111111111111",
    name: "Nightly release audit",
    kind: "service_account",
    total: 58,
  },
  ...people.slice(0, 3),
  {
    userId: "service-account:22222222-2222-4222-8222-222222222222",
    name: "Incident triage bot",
    kind: "service_account",
    total: 19,
  },
  ...people.slice(3),
  // Ids whose owning row is gone — a person and an account, still tellable
  // apart because `kind` says what the id addressed, not whether it resolved.
  { userId: "demo-user-departed", name: null, kind: "user", total: 7 },
  {
    userId: "service-account:33333333-3333-4333-8333-333333333333",
    name: null,
    kind: "service_account",
    total: 3,
  },
  // Activations recorded with no signed-in user at all.
  { userId: null, name: null, kind: "unattributed", total: 12 },
]);

/** A quieter skill: few enough actors that the breakdown needs no search box. */
export const skillUsageStatisticsQuietSeed: UsageStatistics = buildStatistics([
  { userId: "demo-user-0", name: NAMES[0], kind: "user", total: 6 },
  { userId: "demo-user-1", name: NAMES[1], kind: "user", total: 3 },
  { userId: null, name: null, kind: "unattributed", total: 1 },
]);

/** A skill nobody has run yet, for the empty state. */
export const skillUsageStatisticsEmptySeed: UsageStatistics = buildStatistics(
  [],
);

// === internal ===

/**
 * Spreads each actor's total across the window as whole activations, so the
 * chart's bars sum to the totals printed beside them — the property the panel
 * is meant to guarantee, which a hand-written fixture would quietly break.
 *
 * The spread is deterministic and uneven: each actor gets a different stride
 * through the days, which leaves quiet days and a couple of busy ones rather
 * than a flat block.
 */
function buildStatistics(users: UsageActor[]): UsageStatistics {
  const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
  const startOfToday = Date.parse(
    `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
  );
  const dayIso = (offset: number) =>
    new Date(startOfToday - offset * DAY_MS).toISOString().slice(0, 10);

  const counts = new Map<string, DailyBucket>();
  users.forEach((user, actorIndex) => {
    for (let activation = 0; activation < user.total; activation++) {
      // A per-actor stride keeps two actors from landing on the same rhythm,
      // and the squared term bunches some activations into shared busy days.
      const offset =
        (activation * (3 + (actorIndex % 5)) +
          actorIndex * 7 +
          ((activation * activation) % 4)) %
        WINDOW_DAYS;
      const date = dayIso(offset);
      const key = `${date}|${user.userId ?? ""}`;
      const bucket = counts.get(key);
      if (bucket) {
        bucket.count += 1;
      } else {
        counts.set(key, { date, userId: user.userId, count: 1 });
      }
    }
  });

  return {
    since: since.toISOString(),
    users: [...users].sort((a, b) => b.total - a.total),
    daily: [...counts.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
