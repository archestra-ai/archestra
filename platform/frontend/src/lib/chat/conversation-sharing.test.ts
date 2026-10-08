// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isConversationShared } from "./conversation-sharing";

const owner = {
  subject: { type: "user" as const, id: "owner" },
  actions: ["read" as const, "manage-permissions" as const],
};

describe("isConversationShared", () => {
  it("is not shared when only the owner holds read", () => {
    expect(isConversationShared({ grants: [owner], ownerId: "owner" })).toBe(
      false,
    );
  });

  it("is not shared with no grants of its own", () => {
    expect(isConversationShared({ grants: [], ownerId: "owner" })).toBe(false);
  });

  it("is shared when someone besides the owner can read it", () => {
    expect(
      isConversationShared({
        grants: [
          owner,
          { subject: { type: "team", id: "team-1" }, actions: ["read"] },
        ],
        ownerId: "owner",
      }),
    ).toBe(true);
  });

  it("ignores grants that do not include read", () => {
    expect(
      isConversationShared({
        grants: [
          owner,
          {
            subject: { type: "user", id: "other" },
            actions: ["manage-permissions"],
          },
        ],
        ownerId: "owner",
      }),
    ).toBe(false);
  });
});
