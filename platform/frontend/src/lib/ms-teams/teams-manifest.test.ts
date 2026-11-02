// @vitest-environment node
import { expect, test } from "vitest";
import { buildTeamsManifest } from "./teams-manifest";

test("every discoverable command inserts executable text rather than its description", () => {
  const manifest = buildTeamsManifest({
    botAppId: "bot-id",
    nameShort: "Test Bot",
    nameFull: "Test Bot",
    version: "1.0.1",
  });
  for (const list of manifest.bots[0].commandLists) {
    for (const command of list.commands) {
      // Teams' prompt starter contract inserts prompt, not title/description.
      const insertedText =
        command.type === "prompt" ? command.prompt : command.description;
      expect(["/select-agent", "/status", "/help", "/sign-out"]).toContain(
        insertedText,
      );
      expect(insertedText).toBe(command.title);
      expect(command.description).not.toBe(insertedText);
    }
  }
});
