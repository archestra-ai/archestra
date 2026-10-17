// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import {
  type PermissionSubject,
  RESOURCE_ACCESS_RELATIONS,
  type ResourceAccessRelation,
} from "@archestra/shared";
import { type SQL, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

// The Show filter and the audience labels are read for every row of a list,
// so they are written as primary-key probes with JSONB containment. These
// tests pin them to the definition they replace: an aggregate over each grant
// entry (`sharedAudience`) and an EXISTS over the entries for "shared",
// evaluated on every combination of grant entries the tests can name.

const CALLER = "caller-user";
const CALLER_SA = "caller-service-account";
const OWNER = "owner-user";
const OTHER = "other-user";
const CALLER_TEAM = "caller-team";
const OTHER_TEAM = "other-team";

const CALLER_SUBJECTS: PermissionSubject[] = [
  { type: "user", id: CALLER },
  { type: "serviceAccount", id: CALLER_SA },
  { type: "team", id: CALLER_TEAM },
  // Role and organization subjects are part of a resolved principal; the
  // "shared" relation must ignore them.
  { type: "role", id: "member" },
  { type: "organization", id: "*" },
];

const ENTRY_SUBJECTS: Array<(owner: string | null) => PermissionSubject> = [
  () => ({ type: "organization", id: "*" }),
  () => ({ type: "role", id: "member" }),
  () => ({ type: "team", id: CALLER_TEAM }),
  () => ({ type: "team", id: OTHER_TEAM }),
  (owner) => ({ type: "user", id: owner ?? OWNER }),
  () => ({ type: "user", id: CALLER }),
  () => ({ type: "user", id: OTHER }),
  () => ({ type: "serviceAccount", id: CALLER_SA }),
  () => ({ type: "serviceAccount", id: "other-service-account" }),
  // A caller id under the other self type still reaches the caller.
  () => ({ type: "user", id: CALLER_SA }),
  () => ({ type: "serviceAccount", id: CALLER }),
];
const ACTIONS = [["read", "use"], ["use"]];

describe("policy relation predicates", () => {
  test("match the per-entry definition for every grant combination, owner and relation subset", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const entries = (owner: string | null) =>
      ENTRY_SUBJECTS.flatMap((subject) =>
        ACTIONS.map((actions) => ({ subject: subject(owner), actions })),
      );
    // Every policy of up to two entries, plus objects with no policy at all,
    // for an object the caller owns, one someone else owns, and one with no
    // owner.
    const objects: Array<{ scope: string; owner: string | null }> = [];
    const policies: Array<
      typeof schema.resourcePermissionPoliciesTable.$inferInsert
    > = [];
    for (const owner of [CALLER, OWNER, null]) {
      const all = entries(owner);
      const grantSets = [
        null,
        [],
        ...all.map((entry) => [entry]),
        ...all.flatMap((first, index) =>
          all.slice(index + 1).map((second) => [first, second]),
        ),
      ];
      for (const grants of grantSets) {
        const scope = crypto.randomUUID();
        objects.push({ scope, owner });
        if (grants)
          policies.push({
            organizationId: org.id,
            resource: "skill",
            scope,
            grants: grants as never,
          });
      }
    }
    // Arbitrary grant combinations are the point here, so they are written
    // directly rather than through an object's create path.
    for (let index = 0; index < policies.length; index += 500)
      await db
        .insert(schema.resourcePermissionPoliciesTable)
        .values(policies.slice(index, index + 500));

    const columns = {
      organizationId: org.id,
      resource: "skill" as const,
      scopeColumn: sql`object.scope`,
      ownerColumn: sql`object.owner`,
    };
    const predicates: Array<{ name: string; actual: SQL; expected: SQL }> = [];
    for (const audience of ["personal", "team", "org"] as const)
      predicates.push({
        name: `audienceIs(${audience})`,
        actual: ResourcePermissionPolicyModel.audienceIs({
          ...columns,
          audience,
        }),
        expected: referenceAudienceIs(org.id, audience),
      });
    for (const relations of subsets(RESOURCE_ACCESS_RELATIONS)) {
      const actual = ResourcePermissionPolicyModel.accessRelationCondition({
        ...columns,
        userId: CALLER,
        subjects: CALLER_SUBJECTS,
        relations,
      });
      const expected = referenceRelations(org.id, relations);
      // Selecting no relation or every relation filters nothing.
      expect(actual === undefined, relations.join(",")).toBe(
        expected === undefined,
      );
      if (actual && expected)
        predicates.push({ name: relations.join(","), actual, expected });
    }

    const { rows } = await db.execute<Record<string, boolean | string>>(sql`
      SELECT object.scope, ${sql.join(
        predicates.flatMap(({ actual, expected }, index) => [
          sql`${actual} AS ${sql.identifier(`actual_${index}`)}`,
          sql`${expected} AS ${sql.identifier(`expected_${index}`)}`,
        ]),
        sql`, `,
      )}
      FROM unnest(
        ${sql`ARRAY[${sql.join(
          objects.map(({ scope }) => sql`${scope}`),
          sql`, `,
        )}]::text[]`},
        ${sql`ARRAY[${sql.join(
          objects.map(({ owner }) => sql`${owner}`),
          sql`, `,
        )}]::text[]`}
      ) AS object(scope, owner)
    `);

    expect(rows).toHaveLength(objects.length);
    predicates.forEach(({ name }, index) => {
      const mismatches = rows.filter(
        (row) => row[`actual_${index}`] !== row[`expected_${index}`],
      );
      expect(mismatches, name).toEqual([]);
      // Each predicate keeps some objects and rejects others, so a constant
      // answer on both sides cannot pass.
      const kept = rows.filter((row) => row[`actual_${index}`] === true);
      expect(kept.length, name).toBeGreaterThan(0);
      expect(kept.length, name).toBeLessThan(rows.length);
    });
  });
});

function subsets<T>(values: readonly T[]): T[][] {
  return Array.from({ length: 2 ** values.length }, (_, mask) =>
    values.filter((_, bit) => mask & (1 << bit)),
  );
}

// ===
// Reference definitions, per grant entry
// ===

function referenceSharedAudience(organizationId: string) {
  return sql`(
    SELECT CASE
      WHEN bool_or(entry->'subject'->>'type' IN ('organization', 'role')) THEN 'organization'
      WHEN bool_or(entry->'subject'->>'type' = 'team') THEN 'team'
      WHEN bool_or(entry->'subject'->>'type' = 'serviceAccount'
        OR (entry->'subject'->>'type' = 'user'
          AND entry->'subject'->>'id' IS DISTINCT FROM object.owner)) THEN 'user'
    END
    FROM resource_permission_policies policy, jsonb_array_elements(policy.grants) entry
    WHERE policy.organization_id = ${organizationId}
      AND policy.resource = 'skill'
      AND policy.scope = object.scope
      AND (entry->'actions') ? 'read'
  )`;
}

function referenceAudienceIs(
  organizationId: string,
  audience: "personal" | "team" | "org",
): SQL {
  const shared = referenceSharedAudience(organizationId);
  switch (audience) {
    case "org":
      return sql`coalesce(${shared} = 'organization', false)`;
    case "team":
      return sql`coalesce(${shared} = 'team', false)`;
    case "personal":
      return sql`coalesce(${shared}, 'user') = 'user'`;
  }
}

function referenceRelations(
  organizationId: string,
  relations: ResourceAccessRelation[],
): SQL | undefined {
  if (
    relations.length === 0 ||
    relations.length === RESOURCE_ACCESS_RELATIONS.length
  )
    return undefined;
  const mine = sql`coalesce(object.owner = ${CALLER}, false)`;
  const shared = sql`EXISTS (
    SELECT 1 FROM resource_permission_policies policy, jsonb_array_elements(policy.grants) entry
    WHERE policy.organization_id = ${organizationId}
      AND policy.resource = 'skill'
      AND policy.scope = object.scope
      AND (entry->'actions') ? 'read'
      AND ((entry->'subject'->>'type' = 'team' AND entry->'subject'->>'id' IN (${CALLER_TEAM}))
        OR (entry->'subject'->>'type' IN ('user', 'serviceAccount')
          AND entry->'subject'->>'id' IN (${CALLER}, ${CALLER_SA})
          AND entry->'subject'->>'id' IS DISTINCT FROM object.owner))
  )`;
  const org = referenceAudienceIs(organizationId, "org");
  const byRelation: Record<ResourceAccessRelation, SQL> = {
    mine,
    shared,
    org,
    others: sql`NOT (${mine} OR ${shared} OR ${org})`,
  };
  return sql`(${sql.join(
    relations.map((relation) => byRelation[relation]),
    sql` OR `,
  )})`;
}
