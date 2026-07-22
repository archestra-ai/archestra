import { describe, expect, it } from "vitest";
import { canCreateProjectFromChat } from "./can-create-project-from-chat";

const userChat = { origin: "user", projectId: null };

describe("canCreateProjectFromChat", () => {
  it("allows a user chat not yet in a project when permission is present", () => {
    expect(
      canCreateProjectFromChat({
        hasCreatePermission: true,
        conversation: userChat,
      }),
    ).toBe(true);
  });

  it("hides it without create permission", () => {
    expect(
      canCreateProjectFromChat({
        hasCreatePermission: false,
        conversation: userChat,
      }),
    ).toBe(false);
  });

  it("hides it when the chat already belongs to a project", () => {
    expect(
      canCreateProjectFromChat({
        hasCreatePermission: true,
        conversation: { origin: "user", projectId: "proj-1" },
      }),
    ).toBe(false);
  });

  it("hides it for a scheduled-run chat", () => {
    expect(
      canCreateProjectFromChat({
        hasCreatePermission: true,
        conversation: { origin: "schedule_trigger", projectId: null },
      }),
    ).toBe(false);
  });
});
