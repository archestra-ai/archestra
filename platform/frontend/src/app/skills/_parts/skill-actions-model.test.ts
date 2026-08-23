import { describe, expect, it } from "vitest";
import { getSkillActionModel } from "./skill-actions-model";

describe("getSkillActionModel", () => {
  it("keeps table and detail actions in one canonical order", () => {
    const model = getSkillActionModel("skill-1");

    expect(model.map((action) => action.id)).toEqual([
      "chat",
      "edit",
      "usage",
      "history",
      "delete",
    ]);
    expect(model[0]).toMatchObject({
      label: "Chat",
      href: "/chat/new?skill_id=skill-1",
      permissions: { chat: ["read", "create"] },
    });
  });
});
