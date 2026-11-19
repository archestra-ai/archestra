// @vitest-environment node
import { expect, test } from "vitest";
import { buildTeamsManifest } from "./teams-manifest";

test("command menus show readable descriptions and insert executable prompts", () => {
  const manifest = buildTeamsManifest({
    botAppId: "bot-id",
    nameShort: "Test Bot",
    nameFull: "Test Bot",
    version: "1.0.1",
  });
  expect(manifest.manifestVersion).toBe("1.30");
  expect(manifest.$schema).toContain("/v1.30/");
  expect(manifest.supportsChannelFeatures).toBe("tier1");
  for (const list of manifest.bots[0].commandLists) {
    for (const command of list.commands) {
      expect(["/select-agent", "/status", "/help", "/sign-out"]).toContain(
        command.prompt,
      );
      expect(command.prompt).toBe(command.title);
      expect(command.description).not.toBe(command.prompt);
      expect(command.description.length).toBeGreaterThan(command.title.length);
      expect(command.type).toBe("prompt");
    }
  }
});
