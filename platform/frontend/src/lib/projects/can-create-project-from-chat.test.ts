import { describe, expect, it } from "vitest";
import { canCreateProjectFromChat } from "./can-create-project-from-chat";

const userChat = { origin: "user", projectName: null };

describe("canCreateProjectFromChat", () => {
  it("allows a user chat not yet in a project when the feature and permission are present", () => {
    expect(
      canCreateProjectFromChat({
        projectsEnabled: true,
        hasCreatePermission: true,
        conversation: userChat,
      }),
    ).toBe(true);
  });

  it("hides it when the projects feature is off", () => {
    expect(
      canCreateProjectFromChat({
        projectsEnabled: false,
        hasCreatePermission: true,
        conversation: userChat,
      }),
    ).toBe(false);
  });

  it("hides it without create permission", () => {
    expect(
      canCreateProjectFromChat({
        projectsEnabled: true,
        hasCreatePermission: false,
        conversation: userChat,
      }),
    ).toBe(false);
  });

  it("hides it when the chat already belongs to a project", () => {
    expect(
      canCreateProjectFromChat({
        projectsEnabled: true,
        hasCreatePermission: true,
        conversation: { origin: "user", projectName: "Research" },
      }),
    ).toBe(false);
  });

  it("hides it for a scheduled-run chat", () => {
    expect(
      canCreateProjectFromChat({
        projectsEnabled: true,
        hasCreatePermission: true,
        conversation: { origin: "schedule_trigger", projectName: null },
      }),
    ).toBe(false);
  });
});
