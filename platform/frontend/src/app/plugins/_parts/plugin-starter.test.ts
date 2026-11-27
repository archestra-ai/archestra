import { describe, expect, it } from "vitest";
import type { PluginClientType } from "./plugin-content-fields";
import { blankPluginDraft, patchNewPluginDraft } from "./plugin-draft";
import type { PluginPlatform } from "./plugin-platforms";
import { pluginStarterFiles } from "./plugin-starter";

const starter = (
  clientType: PluginClientType,
  supportedPlatforms: PluginPlatform[] = ["posix", "windows"],
) =>
  pluginStarterFiles({
    clientType,
    supportedPlatforms,
    displayName: "Session Guard",
    description: "Checks each session.",
  });
const paths = (files: { path: string }[]) => files.map((file) => file.path);
const read = (files: { path: string; content: string }[], path: string) => {
  const file = files.find((entry) => entry.path === path);
  if (!file) throw new Error(`No ${path} among ${paths(files).join(", ")}`);
  return file.content;
};

describe("pluginStarterFiles", () => {
  it.each([
    ["claude-code", ".claude-plugin/plugin.json", "hooks/hooks.json"],
    ["claude-desktop", ".claude-plugin/plugin.json", "hooks/hooks.json"],
    ["codex", ".codex-plugin/plugin.json", "hooks/hooks.json"],
    ["cursor", ".cursor-plugin/plugin.json", "hooks/hooks.json"],
    ["copilot-cli", "plugin.json", "hooks.json"],
  ] as const)("lays %s out the way that client reads it: manifest at %s, hooks at %s", (clientType, manifestPath, hooksPath) => {
    const files = starter(clientType);

    // The README first: it is the file the editor opens.
    expect(files[0].path).toBe("README.md");
    expect(paths(files)).toEqual(
      expect.arrayContaining([
        manifestPath,
        hooksPath,
        "skills/hello/SKILL.md",
      ]),
    );
    // Every file is there to edit from, so none is empty.
    for (const file of files) expect(file.content.trim()).not.toBe("");

    const manifest = JSON.parse(read(files, manifestPath));
    // The name a client installs by: lowercase with hyphens.
    expect(manifest.name).toBe("session-guard");
    expect(manifest.description).toBe("Checks each session.");
    // Versioned where it is published, not pinned in the manifest.
    expect(manifest.version).toBeUndefined();
    // Valid JSON with one hook for the start of a session.
    const hooks = JSON.parse(read(files, hooksPath)).hooks;
    expect(Object.keys(hooks)).toHaveLength(1);
    expect(Object.keys(hooks)[0].toLowerCase()).toBe("sessionstart");
  });

  it("writes each client's hook in that client's own shape", () => {
    expect(
      JSON.parse(read(starter("claude-code"), "hooks/hooks.json")).hooks
        .SessionStart[0].hooks[0],
    ).toEqual({
      type: "command",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the client substitutes this variable
      command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"',
    });
    expect(
      JSON.parse(read(starter("codex"), "hooks/hooks.json")).hooks
        .SessionStart[0].hooks[0].command,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the client substitutes this variable
    ).toBe('node "${PLUGIN_ROOT}/scripts/session-start.mjs"');
    expect(
      JSON.parse(read(starter("cursor"), "hooks/hooks.json")).hooks
        .sessionStart,
    ).toEqual([{ command: 'node "./scripts/session-start.mjs"' }]);
    // Copilot CLI's hooks file has a field per shell, so it needs no script.
    const copilot = starter("copilot-cli");
    expect(paths(copilot).some((path) => path.startsWith("scripts/"))).toBe(
      false,
    );
    expect(JSON.parse(read(copilot, "hooks.json"))).toMatchObject({
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: "command",
            bash: expect.stringContaining("additionalContext"),
            powershell: expect.stringContaining("additionalContext"),
          },
        ],
      },
    });
  });

  it("writes the hook for the platforms the plugin supports", () => {
    const hookOf = (platforms: PluginPlatform[]) =>
      JSON.parse(read(starter("claude-code", platforms), "hooks/hooks.json"))
        .hooks.SessionStart[0].hooks[0];

    // One platform: its own shell, and nothing to install.
    expect(paths(starter("claude-code", ["posix"]))).toContain(
      "scripts/session-start.sh",
    );
    expect(hookOf(["posix"]).command).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the client substitutes this variable
      'sh "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh"',
    );
    expect(paths(starter("claude-code", ["windows"]))).toContain(
      "scripts/session-start.ps1",
    );
    expect(hookOf(["windows"])).toMatchObject({ shell: "powershell" });
    // Both: one script that runs on either, and a note that it needs Node.js.
    const both = starter("claude-code", ["posix", "windows"]);
    expect(paths(both)).toContain("scripts/session-start.mjs");
    expect(read(both, "README.md")).toContain("Node.js");

    // Copilot CLI: only the fields of the supported platforms.
    const copilotHook = (platforms: PluginPlatform[]) =>
      JSON.parse(read(starter("copilot-cli", platforms), "hooks.json")).hooks
        .sessionStart[0];
    expect(copilotHook(["posix"]).powershell).toBeUndefined();
    expect(copilotHook(["windows"]).bash).toBeUndefined();
  });

  it("keeps the starter skill's frontmatter one valid value when the name has quotes or a backslash", () => {
    const files = pluginStarterFiles({
      clientType: "claude-code",
      supportedPlatforms: ["posix"],
      displayName: 'ACME "Security" \\ tools',
      description: "",
    });

    const frontmatter = read(files, "skills/hello/SKILL.md").split("---")[1];
    const description = frontmatter
      .split("\n")
      .find((line) => line.startsWith("description: "));
    // One double-quoted scalar from the colon to the end of the line.
    expect(JSON.parse(description?.slice("description: ".length) ?? "")).toBe(
      'An example skill of ACME "Security" \\ tools. Use when the user asks what this plugin can do.',
    );
  });

  it("doubles a typographic apostrophe in the PowerShell hook, which would end its string", () => {
    const starter = (clientType: PluginClientType) =>
      pluginStarterFiles({
        clientType,
        supportedPlatforms: ["windows"],
        displayName: "Sam\u2019s tools",
        description: "",
      });

    expect(read(starter("claude-code"), "scripts/session-start.ps1")).toContain(
      "Write-Output 'Sam\u2019\u2019s tools is installed.'",
    );
    expect(
      JSON.parse(read(starter("copilot-cli"), "hooks.json")).hooks
        .sessionStart[0].powershell,
    ).toContain("Sam\u2019\u2019s tools is installed.");
  });

  it("stands in for a name and a description that are not written yet", () => {
    const files = pluginStarterFiles({
      clientType: "claude-code",
      supportedPlatforms: ["posix"],
      displayName: "  ",
      description: "",
    });

    const manifest = JSON.parse(read(files, ".claude-plugin/plugin.json"));
    expect(manifest.name).toBe("my-plugin");
    expect(manifest.description).not.toBe("");
  });
});

describe("patchNewPluginDraft", () => {
  it("moves untouched starter files to the client and platforms that are picked", () => {
    let draft = blankPluginDraft();
    expect(paths(draft.files)).toContain(".claude-plugin/plugin.json");

    draft = patchNewPluginDraft(draft, { clientType: "cursor" });
    expect(paths(draft.files)).toContain(".cursor-plugin/plugin.json");
    expect(paths(draft.files)).not.toContain(".claude-plugin/plugin.json");

    draft = patchNewPluginDraft(draft, { supportedPlatforms: ["posix"] });
    expect(paths(draft.files)).toContain("scripts/session-start.sh");

    draft = patchNewPluginDraft(draft, { displayName: "Session Guard" });
    expect(
      JSON.parse(read(draft.files, ".cursor-plugin/plugin.json")).name,
    ).toBe("session-guard");
  });

  it("leaves files the author has edited as they are", () => {
    const blank = blankPluginDraft();
    const edited = blank.files.map((file) =>
      file.path === "README.md" ? { ...file, content: "# Mine\n" } : file,
    );
    let draft = patchNewPluginDraft(blank, { files: edited });

    draft = patchNewPluginDraft(draft, { clientType: "codex" });

    // The author's files, not Codex's starter set.
    expect(draft.clientType).toBe("codex");
    expect(draft.files).toEqual(edited);
  });
});
