// @vitest-environment node
import { expect, test } from "vitest";
import { buildTeamsManifest } from "./teams-manifest";

test("command menu descriptions insert executable commands with a compatible schema", () => {
  const manifest = buildTeamsManifest({
    botAppId: "bot-id",
    nameShort: "Test Bot",
    nameFull: "Test Bot",
    version: "1.0.1",
  });
  expect(manifest.manifestVersion).toBe("1.23");
  expect(manifest.$schema).toContain("/v1.23/");
  for (const list of manifest.bots[0].commandLists) {
    for (const command of list.commands) {
      expect(["/select-agent", "/status", "/help", "/sign-out"]).toContain(
        command.description,
      );
      expect(command.description).toBe(command.title);
      expect(command).not.toHaveProperty("type");
      expect(command).not.toHaveProperty("prompt");
    }
  }
});
