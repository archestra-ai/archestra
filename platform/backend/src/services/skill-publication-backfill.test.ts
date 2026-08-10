import { vi } from "vitest";

vi.mock("@/logging");

import { eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import SkillModel from "@/models/skill";
import SkillFileModel from "@/models/skill-file";
import { expect, test } from "@/test";
import type { InsertSkill, Skill } from "@/types";
import { backfillSkillPublicationArtifacts } from "./skill-publication-backfill";

/** A skill with its publication artifacts stripped, as a pre-0407 row is. */
async function makeUndigestedSkill(
  organizationId: string,
  files: Array<{ path: string; content: string }> = [],
): Promise<Skill> {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId,
      name: `skill-${crypto.randomUUID().slice(0, 8)}`,
      description: "A test skill",
      content: "# Instructions\n\nDo the thing.",
      scope: "org",
      latestVersion: 1,
    } as InsertSkill,
    files: files.map((file) => ({
      path: file.path,
      content: file.content,
      encoding: "utf8" as const,
      kind: "reference" as const,
    })),
  });
  if (!skill) throw new Error("failed to create test skill");

  await db
    .update(schema.skillsTable)
    .set({ frontmatterBlob: null, digest: null })
    .where(eq(schema.skillsTable.id, skill.id));
  await db
    .update(schema.skillFilesTable)
    .set({ digest: null })
    .where(eq(schema.skillFilesTable.skillId, skill.id));

  return skill;
}

test("digests every undigested row, whatever its size", async ({
  makeOrganization,
}) => {
  // The read is sized before it is loaded, so a file far larger than its
  // neighbours must still be digested rather than budgeted out of the batch.
  const org = await makeOrganization();
  const small = await makeUndigestedSkill(org.id, [
    { path: "references/GUIDE.md", content: "# Guide" },
  ]);
  const large = await makeUndigestedSkill(org.id, [
    { path: "assets/BIG.txt", content: "x".repeat(200_000) },
  ]);

  await backfillSkillPublicationArtifacts();

  const skills = await db
    .select()
    .from(schema.skillsTable)
    .where(inArray(schema.skillsTable.id, [small.id, large.id]));
  expect(skills).toHaveLength(2);
  for (const skill of skills) {
    expect(skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(skill.frontmatterBlob).toContain(`name: ${skill.name}`);
  }

  const files = await db
    .select()
    .from(schema.skillFilesTable)
    .where(inArray(schema.skillFilesTable.skillId, [small.id, large.id]));
  expect(files).toHaveLength(2);
  for (const file of files) {
    expect(file.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  }
});

test("writes nothing on a second pass over an already-digested catalog", async ({
  makeOrganization,
}) => {
  // Both halves of the read re-apply the missing-artifact filter, so a settled
  // catalog costs the tick two lookups and no writes at all.
  const org = await makeOrganization();
  await makeUndigestedSkill(org.id, [
    { path: "references/GUIDE.md", content: "# Guide" },
  ]);
  await backfillSkillPublicationArtifacts();

  const fillSkills = vi.spyOn(SkillModel, "fillPublicationArtifacts");
  const fillFiles = vi.spyOn(SkillFileModel, "fillDigests");
  await backfillSkillPublicationArtifacts();

  expect(fillSkills).not.toHaveBeenCalled();
  expect(fillFiles).not.toHaveBeenCalled();
  fillSkills.mockRestore();
  fillFiles.mockRestore();
});

test("reports how many rows stay withheld when a pass fails", async ({
  makeOrganization,
}) => {
  // The listing query filters undigested rows out entirely, so a failed pass
  // is otherwise indistinguishable from a catalog that publishes nothing. The
  // count is the only signal an operator gets.
  const org = await makeOrganization();
  await makeUndigestedSkill(org.id, [
    { path: "references/GUIDE.md", content: "# Guide" },
  ]);
  const fill = vi
    .spyOn(SkillModel, "fillPublicationArtifacts")
    .mockRejectedValue(new Error("connection lost"));

  await expect(backfillSkillPublicationArtifacts()).resolves.toBeUndefined();

  expect(logger.error).toHaveBeenCalledWith(
    expect.objectContaining({ skillsWithheld: 1, filesWithheld: 1 }),
    expect.stringContaining("next tick"),
  );
  fill.mockRestore();
});
