import { ProjectModel, ProjectPinModel } from "@/models";
import { describe, expect, test } from "@/test";

async function makeProject(params: {
  organizationId: string;
  userId: string;
  name: string;
}) {
  return ProjectModel.create(params);
}

describe("ProjectPinModel", () => {
  test("pin then unpin round-trip, idempotent", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await makeProject({
      organizationId: org.id,
      userId: user.id,
      name: "p",
    });

    await ProjectPinModel.pin({ userId: user.id, projectId: project.id });
    let pins = await ProjectPinModel.getPinnedAtForProjects({
      userId: user.id,
      projectIds: [project.id],
    });
    expect(pins.get(project.id)).toBeInstanceOf(Date);

    // re-pin does not throw and keeps a single row
    await ProjectPinModel.pin({ userId: user.id, projectId: project.id });

    await ProjectPinModel.unpin({ userId: user.id, projectId: project.id });
    pins = await ProjectPinModel.getPinnedAtForProjects({
      userId: user.id,
      projectIds: [project.id],
    });
    expect(pins.has(project.id)).toBe(false);

    // unpin again is a no-op
    await ProjectPinModel.unpin({ userId: user.id, projectId: project.id });
  });

  test("pins are per-user (one user's pin is invisible to another)", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const a = await makeUser();
    const b = await makeUser({ email: "pin-b@test.com" });
    const project = await makeProject({
      organizationId: org.id,
      userId: a.id,
      name: "shared",
    });

    await ProjectPinModel.pin({ userId: a.id, projectId: project.id });

    const aPins = await ProjectPinModel.getPinnedAtForProjects({
      userId: a.id,
      projectIds: [project.id],
    });
    const bPins = await ProjectPinModel.getPinnedAtForProjects({
      userId: b.id,
      projectIds: [project.id],
    });
    expect(aPins.has(project.id)).toBe(true);
    expect(bPins.has(project.id)).toBe(false);
  });

  test("deleting a project cascade-removes its pins", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await makeProject({
      organizationId: org.id,
      userId: user.id,
      name: "doomed",
    });
    await ProjectPinModel.pin({ userId: user.id, projectId: project.id });

    await ProjectModel.delete(project.id);

    const pins = await ProjectPinModel.getPinnedAtForProjects({
      userId: user.id,
      projectIds: [project.id],
    });
    expect(pins.has(project.id)).toBe(false);
  });
});
