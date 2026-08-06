import { projectService } from "@/services/project";
import { describe, expect, test } from "@/test";

describe("projectService.list (status=deleted)", () => {
  test("a project admin sees every member's soft-deleted projects, org-wide", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const ownerA = await makeUser();
    const ownerB = await makeUser();

    const active = await projectService.create({
      organizationId,
      userId: ownerA.id,
      name: "active",
      description: null,
    });
    const goneA = await projectService.create({
      organizationId,
      userId: ownerA.id,
      name: "gone-a",
      description: null,
    });
    const goneB = await projectService.create({
      organizationId,
      userId: ownerB.id,
      name: "gone-b",
      description: null,
    });
    await projectService.delete({
      id: goneA.id,
      organizationId,
      userId: ownerA.id,
    });
    await projectService.delete({
      id: goneB.id,
      organizationId,
      userId: ownerB.id,
    });

    const deleted = await projectService.list({
      organizationId,
      userId: ownerA.id,
      isProjectAdmin: true,
      status: "deleted",
    });
    const ids = deleted.map((p) => p.id);
    // both deleted projects — including another member's — are visible
    expect(ids).toContain(goneA.id);
    expect(ids).toContain(goneB.id);
    // the active project is not in the deleted slice
    expect(ids).not.toContain(active.id);
    // every row carries deletedAt (for the "deleted N ago" label) and reads as
    // admin oversight
    for (const p of deleted) {
      expect(p.deletedAt).not.toBeNull();
      expect(p.viewerRole).toBe("admin");
    }

    // and the default (active) list still excludes soft-deleted projects
    const activeList = await projectService.list({
      organizationId,
      userId: ownerA.id,
      isProjectAdmin: true,
    });
    const activeIds = activeList.map((p) => p.id);
    expect(activeIds).toContain(active.id);
    expect(activeIds).not.toContain(goneA.id);
  });

  test("a non-admin gets nothing from the deleted slice", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "mine",
      description: null,
    });
    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });

    const deleted = await projectService.list({
      organizationId,
      userId: owner.id,
      isProjectAdmin: false,
      status: "deleted",
    });
    expect(deleted).toEqual([]);
  });
});
