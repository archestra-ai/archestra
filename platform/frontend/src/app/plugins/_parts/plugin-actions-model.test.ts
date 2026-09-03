import { describe, expect, it } from "vitest";
import {
  getPluginActionModel,
  pluginAction,
  pluginActionHref,
} from "./plugin-actions-model";

describe("Plugin action model", () => {
  it("shares canonical labels, permissions, and edit destination", () => {
    const model = getPluginActionModel({
      pluginId: "plugin-1",
      hasPendingUpdate: true,
    });

    expect(pluginAction(model, "install")).toMatchObject({
      label: "Install",
      permissions: { plugin: ["read", "admin"] },
    });
    expect(pluginAction(model, "updates").label).toBe("Review update");
    // Editing is the plugin's own page now, not a route beside it.
    expect(pluginActionHref(pluginAction(model, "edit"))).toBe(
      "/plugins/plugin-1",
    );
    expect(pluginAction(model, "delete")).toMatchObject({
      label: "Delete",
      permissions: { plugin: ["delete", "admin"] },
    });
  });
});
