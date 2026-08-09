import { createHash } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import AgentExcludedSkillModel from "@/models/agent-excluded-skill";
import SkillModel from "@/models/skill";
import SkillFileModel from "@/models/skill-file";
import { backfillSkillPublicationArtifacts } from "@/services/skill-publication-backfill";
import { expect, test, vi } from "@/test";
import type { InsertSkill, Skill } from "@/types";
import { handleSkillMethod, serveSkillResource } from "./skills";

async function makeSkill(
  organizationId: string,
  overrides: Partial<InsertSkill> = {},
  files: Array<{
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
  }> = [],
): Promise<Skill> {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId,
      name: `skill-${crypto.randomUUID().slice(0, 8)}`,
      description: "A test skill",
      content: "# Instructions\n\nDo the thing.",
      scope: "org",
      latestVersion: 1,
      ...overrides,
    } as InsertSkill,
    files: files.map((file) => ({
      path: file.path,
      content: file.content,
      encoding: file.encoding ?? "utf8",
      kind: "reference" as const,
    })),
  });
  if (!skill) throw new Error("failed to create test skill");
  return skill;
}

/**
 * Assign one skill to an agent, additively.
 *
 * A direct insert rather than the service: these tests seed a published set
 * and then exercise the read surface, so the write-time validation the service
 * runs is another file's subject. Additive because the production writer is a
 * full replace, and several tests here build a set one skill at a time.
 */
async function assignSkill(params: { agentId: string; skillId: string }) {
  await db.insert(schema.agentSkillsTable).values(params).onConflictDoNothing();
}

function call(agentId: string, method: string, params: object = {}) {
  return handleSkillMethod({
    body: { jsonrpc: "2.0", id: 1, method, params },
    agentId,
  });
}

function expectResult(outcome: Awaited<ReturnType<typeof call>>) {
  if (!("result" in outcome)) {
    throw new Error(`expected a result, got error: ${JSON.stringify(outcome)}`);
  }
  return outcome.result;
}

test("skills/list returns an entry whose resources enumerate every file", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "pdf-processing" }, [
    { path: "references/FORMS.md", content: "# Forms" },
    { path: "scripts/extract.py", content: "print('hi')" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  const result = expectResult(await call(agent.id, "skills/list"));
  const skills = result.skills as Array<Record<string, unknown>>;

  expect(skills).toHaveLength(1);
  expect(skills[0].uri).toBe(
    "skill://archestra/shared/pdf-processing/SKILL.md",
  );
  expect(skills[0].frontmatter).toEqual({
    name: "pdf-processing",
    description: "A test skill",
  });

  // The enumeration must be complete — a host treats a read of anything
  // unlisted as a verification failure, so a missing entry breaks the skill.
  const resources = skills[0].resources as Array<{
    uri: string;
    digest: string;
  }>;
  expect(resources.map((r) => r.uri).sort()).toEqual([
    "skill://archestra/shared/pdf-processing/SKILL.md",
    "skill://archestra/shared/pdf-processing/references/FORMS.md",
    "skill://archestra/shared/pdf-processing/scripts/extract.py",
  ]);
  for (const resource of resources) {
    expect(resource.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  }
});

test("skills/list marks its result private to this caller", async ({
  makeOrganization,
  makeAgent,
}) => {
  // The set is resolved per gateway, so an intermediary must not share it.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });

  const result = expectResult(await call(agent.id, "skills/list"));

  expect(result.cacheScope).toBe("private");
});

test("skills/list pages without gaps or duplicates", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    accessAllSkills: true,
  });
  for (let i = 0; i < 120; i++) {
    await makeSkill(org.id, { name: `skill-${String(i).padStart(3, "0")}` });
  }

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = expectResult(
      await call(agent.id, "skills/list", cursor ? { cursor } : {}),
    );
    for (const entry of result.skills as Array<{ uri: string }>) {
      seen.push(entry.uri);
    }
    cursor = result.nextCursor as string | undefined;
    if (!cursor) break;
  }

  expect(cursor).toBeUndefined();
  expect(seen).toHaveLength(120);
  expect(new Set(seen).size).toBe(120);
});

test("skills/list never answers an empty page behind a run of withheld skills", async ({
  makeOrganization,
  makeAgent,
}) => {
  // Withheld skills are removed BEFORE the page window is cut, so a run of
  // unpublishable skills — however long — cannot produce `{skills: [],
  // nextCursor}`. A client that stops on an empty page would otherwise
  // conclude the gateway publishes nothing at all.
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    accessAllSkills: true,
  });
  // Ids order the exposed set and are random, so seed every skill unpublishable
  // and then repair the highest-id one — that puts the withheld run first by
  // construction rather than by luck.
  const seeded: Skill[] = [];
  for (let i = 0; i < 56; i++) {
    seeded.push(
      await makeSkill(org.id, { name: `paged-${String(i).padStart(3, "0")}` }, [
        { path: "docs//unreachable.md", content: "no URI names this" },
      ]),
    );
  }
  const last = [...seeded].sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1);
  if (!last) throw new Error("seed failed");
  await SkillModel.updateWithFiles({
    id: last.id,
    // A no-op column write: drizzle rejects an empty SET, and re-writing the
    // same description leaves the publication digest untouched.
    skill: { description: last.description },
    files: [
      {
        path: "references/GOOD.md",
        content: "# Fine",
        kind: "reference",
        encoding: "utf8",
      },
    ],
  });

  // 55 withheld skills sort ahead of the one servable skill, and it still comes
  // back on the first page with no cursor to follow.
  const result = expectResult(await call(agent.id, "skills/list"));
  expect(result.skills).toHaveLength(1);
  expect((result.skills as Array<{ uri: string }>)[0].uri).toBe(
    `skill://archestra/shared/${last.name}/SKILL.md`,
  );
  expect(result.nextCursor).toBeUndefined();
});

test("skills/list never answers an empty page behind a run of excluded skills", async ({
  makeOrganization,
  makeAgent,
}) => {
  // The sibling of the withheld-path case, and the other way a window can come
  // back empty: exclusions are dense by construction — an admin narrowing Auto
  // mode excludes many skills at once — so they are settled in the query the
  // page LIMIT sits on rather than after it.
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    accessAllSkills: true,
  });
  const seeded: Skill[] = [];
  for (let i = 0; i < 56; i++) {
    seeded.push(
      await makeSkill(org.id, {
        name: `excluded-${String(i).padStart(3, "0")}`,
      }),
    );
  }
  // Ids order the exposed set and are random, so exclude everything but the
  // highest-id skill: the survivor then sits behind 55 excluded rows by
  // construction rather than by luck.
  const ordered = [...seeded].sort((a, b) => (a.id < b.id ? -1 : 1));
  const survivor = ordered.at(-1);
  if (!survivor) throw new Error("seed failed");
  await AgentExcludedSkillModel.replaceExclusions({
    agentId: agent.id,
    skillIds: ordered.slice(0, -1).map((skill) => skill.id),
  });

  const result = expectResult(await call(agent.id, "skills/list"));

  expect(result.skills).toHaveLength(1);
  expect((result.skills as Array<{ uri: string }>)[0].uri).toBe(
    `skill://archestra/shared/${survivor.name}/SKILL.md`,
  );
  expect(result.nextCursor).toBeUndefined();
});

test("skills/list fills a page over a catalog dense in unpublishable skills with one query", async ({
  makeOrganization,
  makeAgent,
}) => {
  // Every publication gate is a SQL predicate, so a catalog that is mostly
  // unpublishable — bad names, templated, agent-delegated — costs one bounded
  // query per page, never a re-read. The call-count assertion is the point:
  // the page CONTENT would be identical under an unbounded refill loop, and
  // that is exactly the regression this test exists to catch.
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    accessAllSkills: true,
  });
  for (let i = 0; i < 30; i++) {
    // Uppercase and spaces: storable, but no conforming `skill://` URI names
    // it, so the Agent Skills naming rules withhold it.
    await makeSkill(org.id, { name: `Rejected Name ${i}` });
  }
  for (let i = 0; i < 15; i++) {
    await makeSkill(org.id, { name: `templated-${i}`, templated: true });
  }
  for (let i = 0; i < 10; i++) {
    await makeSkill(org.id, {
      name: `delegating-${i}`,
      agentName: `helper-${i}`,
    });
  }
  for (let i = 0; i < 3; i++) {
    await makeSkill(org.id, { name: `kept-${String(i).padStart(3, "0")}` });
  }

  const pageQueries = vi.spyOn(SkillModel, "findOrgScopedInEnvironment");
  const result = expectResult(await call(agent.id, "skills/list"));
  expect(pageQueries).toHaveBeenCalledTimes(1);
  pageQueries.mockRestore();

  expect(result.skills).toHaveLength(3);
  expect(result.nextCursor).toBeUndefined();
});

test("skills/get answers for an exposed skill and refuses anything else", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const exposed = await makeSkill(org.id, { name: "exposed" });
  await makeSkill(org.id, { name: "unexposed" });
  await assignSkill({ agentId: agent.id, skillId: exposed.id });

  const result = expectResult(
    await call(agent.id, "skills/get", {
      uri: "skill://archestra/shared/exposed/SKILL.md",
    }),
  );
  expect((result.skill as { uri: string }).uri).toBe(
    "skill://archestra/shared/exposed/SKILL.md",
  );

  // An unexposed skill and a nonexistent one must be indistinguishable, or the
  // response becomes a probe for what other gateways publish. Both answer with
  // the same code and the same message shape — which only ever echoes the URI
  // the caller themselves supplied, so it carries no information back.
  for (const name of ["unexposed", "no-such-skill"]) {
    const uri = `skill://archestra/shared/${name}/SKILL.md`;
    expect(await call(agent.id, "skills/get", { uri })).toEqual({
      error: { code: -32602, message: `Unknown skill: ${uri}` },
    });
  }
});

test("skills/get addresses a skill by its manifest URI and nothing else", async ({
  makeOrganization,
  makeAgent,
}) => {
  // SEP-2640 identifies a skill by its SKILL.md. A file inside it, or the root
  // directory, names something real but is not a skill key — answering either
  // would give one skill two identities, and a host that stored the wrong one
  // could never match it against a listing.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "by-key" }, [
    { path: "references/GUIDE.md", content: "# Guide" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  for (const uri of [
    "skill://archestra/shared/by-key/references/GUIDE.md",
    "skill://archestra/shared/by-key",
    "skill://archestra/shared/by-key/",
  ]) {
    expect(await call(agent.id, "skills/get", { uri }), uri).toEqual({
      error: { code: -32602, message: `Unknown skill: ${uri}` },
    });
  }
});

test("skills/list treats a tampered cursor as absent", async ({
  makeOrganization,
  makeAgent,
}) => {
  // A cursor is client-held, so its contents are client-editable. The decoded
  // id lands in `"skills"."id" > $1` against a uuid column, where anything but
  // a UUID makes Postgres raise from inside the listing query — an error this
  // surface has no business answering with. Every unusable spelling restarts
  // the listing instead.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "only-skill" });
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  const cursors = [
    // Not base64url, and base64url that is not JSON.
    "!!!not-base64!!!",
    Buffer.from("not json at all", "utf8").toString("base64url"),
    // JSON, but the id is not a UUID — the spelling Postgres would reject.
    Buffer.from(
      JSON.stringify({ afterId: "'; DROP TABLE skills; --" }),
    ).toString("base64url"),
    Buffer.from(JSON.stringify({ afterId: 42 })).toString("base64url"),
    // A cursor from before the payload changed shape: unknown fields ignored.
    Buffer.from(JSON.stringify({ fingerprint: "stale" })).toString("base64url"),
  ];

  for (const cursor of cursors) {
    const result = expectResult(
      await call(agent.id, "skills/list", { cursor }),
    );
    expect(result.skills, cursor).toHaveLength(1);
  }
});

test("resources/read serves a manifest matching the published digest", async ({
  makeOrganization,
  makeAgent,
}) => {
  // The listed digest and the served bytes are what a host verifies against
  // each other; both are built from the skill's stored frontmatter blob, so
  // they cannot drift.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "readable" });
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  const uri = "skill://archestra/shared/readable/SKILL.md";
  const read = await serveSkillResource({ uri, agentId: agent.id });

  expect(read?.contents[0]).toMatchObject({
    uri,
    mimeType: "text/markdown",
  });
  expect(read?.contents[0].text).toContain("name: readable");
  expect(read?.contents[0].text).toContain("Do the thing.");

  const listed = expectResult(await call(agent.id, "skills/list"));
  const manifestResource = (
    (
      listed.skills as Array<{
        resources: Array<{ uri: string; digest: string }>;
      }>
    )[0]?.resources ?? []
  ).find((resource) => resource.uri === uri);
  // Hashed here rather than reusing the platform helper: the point is that the
  // advertised digest covers the bytes a client actually received.
  expect(manifestResource?.digest).toBe(
    `sha256:${createHash("sha256")
      .update(String(read?.contents[0].text), "utf8")
      .digest("hex")}`,
  );
});

test("skills/list frontmatter describes the published bytes, not the live row", async ({
  makeOrganization,
  makeAgent,
}) => {
  // SEP-2640 has hosts verify the entry's frontmatter against the served
  // SKILL.md, so both must derive from the stored blob. Rewriting that blob to
  // bytes the current serializer would not emit stands in for a serializer
  // change: it is exactly the state every un-rewritten skill lands in, and the
  // two surfaces have to follow the blob rather than the columns.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "pinned-bytes" });
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  await db
    .update(schema.skillsTable)
    .set({
      frontmatterBlob:
        'name: "pinned-bytes"\ndescription: "As published"\nlicense: "MIT"\n',
    })
    .where(eq(schema.skillsTable.id, skill.id));

  const listed = expectResult(await call(agent.id, "skills/list"));
  const entry = (listed.skills as Array<Record<string, unknown>>)[0];

  // `license` exists only in the blob and the description differs from the
  // column, so neither field could have come from the row.
  expect(entry.frontmatter).toEqual({
    name: "pinned-bytes",
    description: "As published",
    license: "MIT",
  });

  const read = await serveSkillResource({
    uri: "skill://archestra/shared/pinned-bytes/SKILL.md",
    agentId: agent.id,
  });
  const manifest = String(read?.contents[0].text);
  for (const [field, value] of Object.entries(
    entry.frontmatter as Record<string, string>,
  )) {
    expect(manifest).toContain(`${field}: "${value}"`);
  }
});

test("a full page of skills-with-files costs two bounded queries and reads no file bytes", async ({
  makeOrganization,
  makeAgent,
}) => {
  // Digests are written with the bytes they cover, so a listing is identity
  // and digests alone. The read path used to repair legacy rows inline by
  // fetching the content of every undigested file on the page — up to 50
  // whole skill bodies plus their assets, each capped at 10 MB — which on a
  // deployment that had just enabled the flag was EVERY file. Like the paging
  // bound above, the response content is identical either way; only the query
  // shape catches the regression.
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    accessAllSkills: true,
  });
  for (let i = 0; i < 12; i++) {
    await makeSkill(org.id, { name: `paged-${String(i).padStart(3, "0")}` }, [
      { path: "references/GUIDE.md", content: `# Guide ${i}` },
      { path: "scripts/run.py", content: `print(${i})` },
    ]);
  }

  const fileRows = vi.spyOn(SkillFileModel, "findPublicationRowsBySkillIds");
  const pageQueries = vi.spyOn(SkillModel, "findOrgScopedInEnvironment");
  const result = expectResult(await call(agent.id, "skills/list"));

  expect(result.skills).toHaveLength(12);
  expect(pageQueries).toHaveBeenCalledTimes(1);
  // One batched read for every file on the page, never one per skill...
  expect(fileRows).toHaveBeenCalledTimes(1);
  // ...and no `content` column is selected at all.
  expect(fileRows.mock.calls[0][0]).toHaveLength(12);
  fileRows.mockRestore();
  pageQueries.mockRestore();
});

test("withholds a skill written before the digest columns existed until the backfill digests it", async ({
  makeOrganization,
  makeAgent,
}) => {
  // Rows created before publication artifacts were stored carry nulls. A
  // listing never serves an unverifiable skill and never fetches bytes to
  // repair one inline — the startup backfill digests such rows, after which
  // they publish as normal.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "legacy-row" }, [
    { path: "references/GUIDE.md", content: "# Guide" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });
  await db
    .update(schema.skillsTable)
    .set({ frontmatterBlob: null, digest: null })
    .where(eq(schema.skillsTable.id, skill.id));
  await db
    .update(schema.skillFilesTable)
    .set({ digest: null })
    .where(eq(schema.skillFilesTable.skillId, skill.id));

  const before = expectResult(await call(agent.id, "skills/list"));
  expect(before.skills).toHaveLength(0);

  await backfillSkillPublicationArtifacts();

  const result = expectResult(await call(agent.id, "skills/list"));
  const entry = (
    result.skills as Array<{ resources: Array<{ digest: string }> }>
  )[0];
  expect(entry?.resources).toHaveLength(2);
  for (const resource of entry?.resources ?? []) {
    expect(resource.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  }

  const [stored] = await db
    .select()
    .from(schema.skillsTable)
    .where(eq(schema.skillsTable.id, skill.id));
  expect(stored?.frontmatterBlob).toContain("name: legacy-row");
  expect(stored?.digest).toBe(entry?.resources[0]?.digest);
  const [storedFile] = await db
    .select()
    .from(schema.skillFilesTable)
    .where(eq(schema.skillFilesTable.skillId, skill.id));
  expect(storedFile?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("a run of undigested skills never yields an empty page with a cursor", async ({
  makeOrganization,
  makeAgent,
}) => {
  // The artifact gate has to sit inside the query the LIMIT bounds. Settled
  // after the window is cut, a page whose fifty scanned rows are all
  // undigested comes back `{skills: [], nextCursor}` — and plenty of clients
  // stop on an empty page, reading it as "this gateway publishes nothing"
  // while every servable skill sits behind the run.
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    accessAllSkills: true,
  });
  for (let index = 0; index < 52; index++) {
    await makeSkill(org.id, { name: `bulk-skill-${index}` });
  }

  // Ids are random UUIDs and the page is keyed on them, so the row left
  // digested is chosen as the highest — that puts all 51 undigested rows
  // ahead of it in the window whatever order the ids came out in.
  const ordered = await db
    .select({ id: schema.skillsTable.id })
    .from(schema.skillsTable)
    .where(eq(schema.skillsTable.organizationId, org.id))
    .orderBy(asc(schema.skillsTable.id));
  const servable = ordered.at(-1)?.id;
  await db
    .update(schema.skillsTable)
    .set({ frontmatterBlob: null, digest: null })
    .where(
      inArray(
        schema.skillsTable.id,
        ordered.slice(0, -1).map((row) => row.id),
      ),
    );

  const result = expectResult(await call(agent.id, "skills/list"));

  expect(result.skills).toHaveLength(1);
  expect(result.nextCursor).toBeUndefined();
  const [entry] = result.skills as Array<{ uri: string }>;
  const [stored] = await db
    .select()
    .from(schema.skillsTable)
    .where(eq(schema.skillsTable.id, servable ?? ""));
  expect(entry.uri).toBe(`skill://archestra/shared/${stored?.name}/SKILL.md`);
});

test("skills/list withholds a skill holding one undigested file", async ({
  makeOrganization,
  makeAgent,
}) => {
  // One undigested file withholds the whole skill: a resource list missing a
  // readable file is a verification failure to a conforming host. The verdict
  // lives in skill_files, so it too has to be settled before the window.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "half-digested" }, [
    { path: "references/GUIDE.md", content: "# Guide" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });
  await db
    .update(schema.skillFilesTable)
    .set({ digest: null })
    .where(eq(schema.skillFilesTable.skillId, skill.id));

  expect(expectResult(await call(agent.id, "skills/list")).skills).toHaveLength(
    0,
  );

  await backfillSkillPublicationArtifacts();

  expect(expectResult(await call(agent.id, "skills/list")).skills).toHaveLength(
    1,
  );
});

test("a legacy SKILL.md row does not withhold its skill", async ({
  makeOrganization,
  makeAgent,
}) => {
  // The manifest served for that URI is composed from the skill row, so a
  // stored top-level SKILL.md is shadowed and never published — and an
  // undigested one must not withhold a skill whose published bytes are all
  // digested. The SQL gate and `resolveSkillPublicationArtifacts` exempt it
  // for the same reason.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "shadowed-manifest" }, [
    { path: "SKILL.md", content: "# stale copy" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });
  await db
    .update(schema.skillFilesTable)
    .set({ digest: null })
    .where(eq(schema.skillFilesTable.skillId, skill.id));

  const result = expectResult(await call(agent.id, "skills/list"));

  expect(result.skills).toHaveLength(1);
  const [entry] = result.skills as Array<{
    resources: Array<{ uri: string }>;
  }>;
  expect(entry.resources.map((resource) => resource.uri)).toEqual([
    "skill://archestra/shared/shadowed-manifest/SKILL.md",
  ]);
});

test("resources/read returns a binary asset as a blob", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const png = Buffer.from("fake-png-bytes").toString("base64");
  const skill = await makeSkill(org.id, { name: "with-asset" }, [
    { path: "assets/logo.png", content: png, encoding: "base64" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  const read = await serveSkillResource({
    uri: "skill://archestra/shared/with-asset/assets/logo.png",
    agentId: agent.id,
  });

  expect(read?.contents[0]).toMatchObject({
    mimeType: "image/png",
    blob: png,
  });
});

test("resources/read declines a skill this gateway does not publish", async ({
  makeOrganization,
  makeAgent,
}) => {
  // Null, which the read handler answers with not-found — never by proxying
  // upstream, since the skill://archestra namespace is reserved. A `skill://`
  // URI names a skill, it does not grant access to one.
  const org = await makeOrganization();
  const ownGateway = await makeAgent({ organizationId: org.id });
  const otherGateway = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "elsewhere" });
  await assignSkill({
    agentId: otherGateway.id,
    skillId: skill.id,
  });

  const read = await serveSkillResource({
    uri: "skill://archestra/shared/elsewhere/SKILL.md",
    agentId: ownGateway.id,
  });

  expect(read).toBeNull();
});

test("resources/read ignores URIs belonging to other schemes", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });

  expect(
    await serveSkillResource({
      uri: "ui://some-app/index.html",
      agentId: agent.id,
    }),
  ).toBeNull();
});

test("resources/directory/read synthesizes the root listing", async ({
  makeOrganization,
  makeAgent,
}) => {
  // Nothing stores directories, and SKILL.md is not a file row at all — the
  // whole listing is derived from the version's flat file paths.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "pdf" }, [
    { path: "README.md", content: "readme" },
    { path: "templates/invoice.md", content: "invoice" },
    { path: "templates/regional/eu.md", content: "eu" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  const result = expectResult(
    await call(agent.id, "resources/directory/read", {
      uri: "skill://archestra/shared/pdf",
    }),
  );

  expect(result.resources).toEqual([
    {
      uri: "skill://archestra/shared/pdf/SKILL.md",
      name: "SKILL.md",
      mimeType: "text/markdown",
    },
    {
      uri: "skill://archestra/shared/pdf/README.md",
      name: "README.md",
      mimeType: "text/markdown",
    },
    {
      uri: "skill://archestra/shared/pdf/templates",
      name: "templates",
      mimeType: "inode/directory",
    },
  ]);
});

test("resources/directory/read descends into a subdirectory", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "pdf" }, [
    { path: "templates/invoice.md", content: "invoice" },
    { path: "templates/order.md", content: "order" },
    { path: "templates/regional/eu.md", content: "eu" },
    { path: "templates/regional/us.md", content: "us" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  const result = expectResult(
    await call(agent.id, "resources/directory/read", {
      uri: "skill://archestra/shared/pdf/templates",
    }),
  );

  // `regional` appears once, as a directory — not twice, once per file under it.
  expect(result.resources).toEqual([
    {
      uri: "skill://archestra/shared/pdf/templates/invoice.md",
      name: "invoice.md",
      mimeType: "text/markdown",
    },
    {
      uri: "skill://archestra/shared/pdf/templates/order.md",
      name: "order.md",
      mimeType: "text/markdown",
    },
    {
      uri: "skill://archestra/shared/pdf/templates/regional",
      name: "regional",
      mimeType: "inode/directory",
    },
  ]);
});

test("resources/directory/read percent-encodes directory-child URIs", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "pdf" }, [
    { path: "my dir 50%/eu.md", content: "eu" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  const root = expectResult(
    await call(agent.id, "resources/directory/read", {
      uri: "skill://archestra/shared/pdf",
    }),
  );

  const child = (root.resources as Array<Record<string, unknown>>).find(
    (resource) => resource.mimeType === "inode/directory",
  );
  expect(child).toEqual({
    uri: "skill://archestra/shared/pdf/my%20dir%2050%25",
    name: "my dir 50%",
    mimeType: "inode/directory",
  });

  // The emitted URI must read back — a raw `%` or space would make the
  // gateway reject its own listing entry as an unknown directory.
  const listing = expectResult(
    await call(agent.id, "resources/directory/read", {
      uri: child?.uri as string,
    }),
  );
  expect(listing.resources).toEqual([
    {
      uri: "skill://archestra/shared/pdf/my%20dir%2050%25/eu.md",
      name: "eu.md",
      mimeType: "text/markdown",
    },
  ]);
});

test("resources/directory/read rejects a path that is not a directory", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "pdf" }, [
    { path: "templates/invoice.md", content: "invoice" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  expect(
    await call(agent.id, "resources/directory/read", {
      uri: "skill://archestra/shared/pdf/nope",
    }),
  ).toMatchObject({ error: { code: -32602 } });
});

test("an unknown method is reported as method-not-found", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });

  expect(await call(agent.id, "skills/unknown")).toMatchObject({
    error: { code: -32601 },
  });
});

test("a legacy stored SKILL.md file never shadows the synthesized manifest", async ({
  makeOrganization,
  makeAgent,
}) => {
  // Rows written before path validation could store a top-level SKILL.md as a
  // resource file. That row is unreachable by design — reads of the SKILL.md
  // URI always answer with the synthesized manifest — so listing it would
  // publish a duplicate URI whose digest can never verify.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "legacy" }, [
    { path: "SKILL.md", content: "stale pre-validation copy" },
    { path: "references/GUIDE.md", content: "# Guide" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  const result = expectResult(await call(agent.id, "skills/list"));
  const skills = result.skills as Array<Record<string, unknown>>;
  expect(skills).toHaveLength(1);
  const resources = skills[0].resources as Array<{ uri: string }>;
  expect(resources.map((r) => r.uri).sort()).toEqual([
    "skill://archestra/shared/legacy/SKILL.md",
    "skill://archestra/shared/legacy/references/GUIDE.md",
  ]);

  const root = expectResult(
    await call(agent.id, "resources/directory/read", {
      uri: "skill://archestra/shared/legacy",
    }),
  );
  const names = (root.resources as Array<{ name: string }>).map(
    (resource) => resource.name,
  );
  expect(names.filter((name) => name === "SKILL.md")).toHaveLength(1);

  const read = await serveSkillResource({
    uri: "skill://archestra/shared/legacy/SKILL.md",
    agentId: agent.id,
  });
  expect(read?.contents[0].text).toContain("Do the thing.");
  expect(read?.contents[0].text).not.toContain("stale pre-validation copy");
});

test("a legacy file path no skill:// URI can name withholds the whole skill", async ({
  makeOrganization,
  makeAgent,
}) => {
  // `docs//guide.md` parses back as `docs/guide.md`, so its listed URI could
  // never be fetched. Publishing without the file would silently ship an
  // incomplete skill; publishing with it reads as tampering and bricks the
  // skill on the host. Withheld entirely instead — and indistinguishable from
  // a skill that does not exist, matching the probe-resistance contract.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "broken" }, [
    { path: "docs//guide.md", content: "unreachable" },
    { path: "references/GOOD.md", content: "# Fine" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });

  const list = expectResult(await call(agent.id, "skills/list"));
  expect(list.skills).toEqual([]);

  for (const name of ["broken", "no-such-skill"]) {
    const uri = `skill://archestra/shared/${name}/SKILL.md`;
    expect(await call(agent.id, "skills/get", { uri })).toEqual({
      error: { code: -32602, message: `Unknown skill: ${uri}` },
    });
    expect(await serveSkillResource({ uri, agentId: agent.id })).toBeNull();
  }
  expect(
    await serveSkillResource({
      uri: "skill://archestra/shared/broken/references/GOOD.md",
      agentId: agent.id,
    }),
  ).toBeNull();
  expect(
    await call(agent.id, "resources/directory/read", {
      uri: "skill://archestra/shared/broken",
    }),
  ).toMatchObject({ error: { code: -32602 } });
});

test("a soft-deleted assigned skill vanishes from every skill method", async ({
  makeOrganization,
  makeAgent,
}) => {
  // Deleting a skill keeps the assignment row (delete is soft), so the reads
  // must filter it — otherwise token holders keep listing and fetching a
  // skill the org already removed.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "retired" }, [
    { path: "references/GUIDE.md", content: "# Guide" },
  ]);
  await assignSkill({ agentId: agent.id, skillId: skill.id });
  await SkillModel.delete(skill.id);

  const list = expectResult(await call(agent.id, "skills/list"));
  expect(list.skills).toEqual([]);

  const uri = "skill://archestra/shared/retired/SKILL.md";
  expect(await call(agent.id, "skills/get", { uri })).toMatchObject({
    error: { code: -32602 },
  });
  expect(await serveSkillResource({ uri, agentId: agent.id })).toBeNull();
  expect(
    await serveSkillResource({
      uri: "skill://archestra/shared/retired/references/GUIDE.md",
      agentId: agent.id,
    }),
  ).toBeNull();
});
