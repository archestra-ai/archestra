import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { asc, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { initialPolicy } from "@/services/guardrails-policy";
import { expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0532_widen-default-hitl-permits.sql"),
  "utf8",
);

// The block every starting policy carried before this migration.
const OLD = `# Review one exact call that explicitly requires human approval.
[[policy.authority]]
name = "hitl"
hint = "Ask the person running this session to approve this exact call."

[policy.authority.permits]
attention = ["human-approval"]
`;
const NEW = `# Review one exact call for any attention mark, trust or audience gap.
[[policy.authority]]
name = "hitl"
hint = "Ask the person running this session to approve this exact call."

[policy.authority.permits]
trust_below = "trusted"
audience_missing = ["public"]
attention = ["*"]
`;

test("widens the default reviewer only in unsynced policies whose latest revision keeps the block unedited", async ({
  makeOrganization,
  makeUser,
}) => {
  const current = initialPolicy();
  expect(current.split(NEW)).toHaveLength(2);
  const legacy = current.replace(NEW, OLD);
  const author = await makeUser();
  const revisions = schema.guardrailsPolicyRevisionsTable;
  const seed = async (contents: string[]) => {
    const organization = await makeOrganization();
    for (const [index, content] of contents.entries())
      await db.insert(revisions).values({
        organizationId: organization.id,
        revision: index + 1,
        content,
        contentHash: hash(content),
        updatedBy: author.id,
      });
    return organization.id;
  };
  const sync = (organizationId: string, interval: "1h" | null) =>
    db
      .insert(schema.openappaGithubSyncTable)
      .values({ organizationId, interval });

  const untouched = await seed([legacy]);
  const unsyncedSource = await seed([legacy]);
  await sync(unsyncedSource, null);
  const edited = await seed([legacy.replace('"human-approval"', '"review"')]);
  const withoutReviewer = await seed([legacy.replace(OLD, "")]);
  const twice = await seed([`${legacy}\n${OLD}`]);
  const customizedLater = await seed([
    legacy,
    legacy.replace('"human-approval"', '"human-approval", "review"'),
  ]);
  const synced = await seed([legacy]);
  await sync(synced, "1h");
  const neverSaved = (await makeOrganization()).id;

  const before = await snapshot();
  for (let run = 0; run < 2; run++) await db.execute(sql.raw(migrationSql));
  const after = await snapshot();

  for (const organizationId of [untouched, unsyncedSource]) {
    expect(after.get(organizationId)).toEqual([
      ...(before.get(organizationId) ?? []),
      {
        revision: 2,
        content: current,
        contentHash: hash(current),
        updatedBy: null,
      },
    ]);
  }
  for (const organizationId of [
    edited,
    withoutReviewer,
    twice,
    customizedLater,
    synced,
  ])
    expect(after.get(organizationId)).toEqual(before.get(organizationId));
  expect(after.has(neverSaved)).toBe(false);
});

function hash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

async function snapshot() {
  const revisions = schema.guardrailsPolicyRevisionsTable;
  const rows = await db
    .select({
      organizationId: revisions.organizationId,
      revision: revisions.revision,
      content: revisions.content,
      contentHash: revisions.contentHash,
      updatedBy: revisions.updatedBy,
    })
    .from(revisions)
    .orderBy(asc(revisions.revision));
  const byOrganization = new Map<
    string,
    Omit<(typeof rows)[number], "organizationId">[]
  >();
  for (const { organizationId, ...row } of rows)
    byOrganization.set(organizationId, [
      ...(byOrganization.get(organizationId) ?? []),
      row,
    ]);
  return byOrganization;
}
