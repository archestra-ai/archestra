import type {
  PluginClientType,
  PluginFileDraft,
} from "./plugin-content-fields";
import type { PluginPlatform } from "./plugin-platforms";

/**
 * The files a new plugin starts with: a working example in the layout the
 * chosen client reads, to edit from.
 *
 * Each client has its own layout, so the set follows the client: where its
 * manifest goes, how its hooks file is shaped, and how a hook finds a script
 * inside the plugin. It follows the platforms too, because a hook is a shell
 * command: `sh` for macOS and Linux, PowerShell for Windows, and Node.js when
 * one command has to run on both.
 *
 * Every set holds the same five things: the manifest, a hooks file with one
 * hook that runs when a session starts, the script that hook runs, a skill,
 * and a README that says what each folder is for.
 *
 * The manifest carries no `version`: the plugin is versioned on every change
 * where it is published, and a fixed version in the manifest would keep
 * installed copies on it until someone raised it by hand.
 */
export function pluginStarterFiles(params: {
  clientType: PluginClientType;
  supportedPlatforms: PluginPlatform[];
  displayName: string;
  description: string;
}): PluginFileDraft[] {
  const layout = LAYOUTS[params.clientType];
  const name = params.displayName.trim() || "My plugin";
  const slug = starterSlug(params.displayName);
  const description = params.description.trim() || `What ${name} does.`;
  const shell = starterShell(params.supportedPlatforms);
  const script = layout.inlineHook ? null : starterScript({ shell, layout });
  const hookCommand = script ? script.command : null;

  const files: PluginFileDraft[] = [
    text(
      layout.manifestPath,
      json(layout.manifest({ slug, name, description })),
    ),
    text(
      layout.hooksPath,
      json(
        layout.hooks({
          command: hookCommand ?? "",
          shell,
          message: `${name} is installed.`,
        }),
      ),
    ),
    ...(script ? [script.file(`${name} is installed.`)] : []),
    text(
      "skills/hello/SKILL.md",
      [
        "---",
        "name: hello",
        `description: "An example skill of ${name}. Use when the user asks what this plugin can do."`,
        "---",
        "",
        "# Hello",
        "",
        `Tell the user that ${name} is installed, and list what it adds:`,
        "",
        "- one hook, which runs when a session starts",
        "- this skill",
        "",
        "Replace these instructions with your own.",
        "",
      ].join("\n"),
    ),
    text(
      "README.md",
      readme({ name, layout, hasScript: script !== null, shell }),
    ),
  ];
  // The README first: it is the file the editor opens, and it says what the
  // others are for.
  return files.sort(
    (a, b) =>
      Number(b.path === "README.md") - Number(a.path === "README.md") ||
      a.path.localeCompare(b.path),
  );
}

/** Whether two file sets hold the same files with the same contents. */
export function samePluginFiles(
  a: PluginFileDraft[],
  b: PluginFileDraft[],
): boolean {
  if (a.length !== b.length) return false;
  const byPath = new Map(b.map((file) => [file.path, file]));
  return a.every((file) => {
    const other = byPath.get(file.path);
    return (
      other !== undefined &&
      other.content === file.content &&
      other.mode === file.mode &&
      other.encoding === file.encoding
    );
  });
}

// === Internal helpers ===

/** What a hook command is written in, for the platforms the plugin supports. */
type StarterShell = "sh" | "powershell" | "node";

interface StarterLayout {
  /** The client's name for the README. */
  client: string;
  manifestPath: string;
  hooksPath: string;
  manifest: (params: {
    slug: string;
    name: string;
    description: string;
  }) => Record<string, unknown>;
  hooks: (params: {
    /** The command that runs the starter script. */
    command: string;
    shell: StarterShell;
    /** What the hook says, where it is written inline. */
    message: string;
  }) => Record<string, unknown>;
  /**
   * How a hook command names the plugin's own folder: a variable the client
   * substitutes, or `.` where the client's own examples use a path relative
   * to that folder.
   */
  pluginRoot: string;
  /** The hook runs in PowerShell when the hooks file says so (`shell`). */
  hookShellField?: boolean;
  /**
   * The hook's command is written in the hooks file itself, with no script:
   * for a client whose hooks file has a field per shell.
   */
  inlineHook?: boolean;
  /** What the starter script prints for the client to add to the session. */
  output: (message: string) => string;
  /** Folders the client reads that the starter does not fill. */
  moreFolders: Array<[string, string]>;
}

const plainOutput = (message: string) => message;

/** Claude Code and Claude Desktop read the same plugin format. */
const CLAUDE_LAYOUT: StarterLayout = {
  client: "Claude Code",
  manifestPath: ".claude-plugin/plugin.json",
  hooksPath: "hooks/hooks.json",
  manifest: ({ slug, name, description }) => ({
    name: slug,
    displayName: name,
    description,
  }),
  hooks: ({ command, shell }) => ({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command,
              ...(shell === "powershell" ? { shell: "powershell" } : {}),
            },
          ],
        },
      ],
    },
  }),
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the client substitutes this variable
  pluginRoot: "${CLAUDE_PLUGIN_ROOT}",
  hookShellField: true,
  output: plainOutput,
  moreFolders: [
    ["agents/", "subagents, one Markdown file each"],
    ["commands/", "slash commands, one Markdown file each"],
    [".mcp.json", "MCP servers the plugin adds"],
  ],
};

const LAYOUTS: Record<PluginClientType, StarterLayout> = {
  "claude-code": CLAUDE_LAYOUT,
  "claude-desktop": { ...CLAUDE_LAYOUT, client: "Claude Desktop" },
  codex: {
    client: "Codex",
    manifestPath: ".codex-plugin/plugin.json",
    hooksPath: "hooks/hooks.json",
    manifest: ({ slug, name, description }) => ({
      name: slug,
      description,
      skills: "./skills/",
      interface: { displayName: name },
    }),
    hooks: ({ command }) => ({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command,
                statusMessage: "Loading plugin context",
              },
            ],
          },
        ],
      },
    }),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the client substitutes this variable
    pluginRoot: "${PLUGIN_ROOT}",
    output: plainOutput,
    moreFolders: [
      [".mcp.json", "MCP servers the plugin adds"],
      ["assets/", "icons and logos the manifest points at"],
    ],
  },
  cursor: {
    client: "Cursor",
    manifestPath: ".cursor-plugin/plugin.json",
    hooksPath: "hooks/hooks.json",
    manifest: ({ slug, description }) => ({ name: slug, description }),
    hooks: ({ command }) => ({
      hooks: { sessionStart: [{ command }] },
    }),
    // Cursor's plugin examples name hook scripts relative to the plugin.
    pluginRoot: ".",
    output: (message) => JSON.stringify({ additional_context: message }),
    moreFolders: [
      ["rules/", "rules, as .mdc files"],
      ["agents/", "subagents, one Markdown file each"],
      ["commands/", "commands, one Markdown file each"],
      ["mcp.json", "MCP servers the plugin adds"],
    ],
  },
  "copilot-cli": {
    client: "Copilot CLI",
    manifestPath: "plugin.json",
    hooksPath: "hooks.json",
    manifest: ({ slug, description }) => ({ name: slug, description }),
    // One field per shell, so the command is written here for each platform
    // the plugin supports and needs no script.
    hooks: ({ shell, message }) => {
      const output = JSON.stringify({ additionalContext: message });
      // Inside single quotes, each shell writes a single quote its own way.
      const forBash = output.replaceAll("'", "'\\''");
      const forPowershell = output.replaceAll("'", "''");
      return {
        version: 1,
        hooks: {
          sessionStart: [
            {
              type: "command",
              ...(shell === "powershell"
                ? {}
                : { bash: `printf '%s\\n' '${forBash}'` }),
              ...(shell === "sh"
                ? {}
                : { powershell: `Write-Output '${forPowershell}'` }),
              timeoutSec: 10,
            },
          ],
        },
      };
    },
    pluginRoot: ".",
    inlineHook: true,
    output: (message) => JSON.stringify({ additionalContext: message }),
    moreFolders: [
      ["agents/", "agents, as .agent.md files"],
      [".mcp.json", "MCP servers the plugin adds"],
    ],
  },
};

function starterShell(platforms: PluginPlatform[]): StarterShell {
  const posix = platforms.includes("posix");
  const windows = platforms.includes("windows");
  if (posix && windows) return "node";
  return windows ? "powershell" : "sh";
}

/** The script the starter hook runs, and the command that runs it. */
function starterScript(params: { shell: StarterShell; layout: StarterLayout }) {
  const { shell, layout } = params;
  // The whole path in double quotes: a plugin can be installed under a
  // folder with a space in its name.
  const scriptAt = (path: string) => `"${layout.pluginRoot}/${path}"`;
  const comment =
    "Runs when a session starts. What it prints is added to the session.";
  if (shell === "sh") {
    const path = "scripts/session-start.sh";
    return {
      command: `sh ${scriptAt(path)}`,
      file: (message: string) =>
        text(
          path,
          `#!/bin/sh\n# ${comment}\nprintf '%s\\n' '${layout.output(message).replaceAll("'", "'\\''")}'\n`,
        ),
    };
  }
  if (shell === "powershell") {
    const path = "scripts/session-start.ps1";
    return {
      command: layout.hookShellField
        ? `& ${scriptAt(path)}`
        : `powershell -NoProfile -ExecutionPolicy Bypass -File ${scriptAt(path)}`,
      file: (message: string) =>
        text(
          path,
          `# ${comment}\nWrite-Output '${layout.output(message).replaceAll("'", "''")}'\n`,
        ),
    };
  }
  const path = "scripts/session-start.mjs";
  return {
    command: `node ${scriptAt(path)}`,
    file: (message: string) =>
      text(
        path,
        `// ${comment}\n// Written for Node.js so that one script runs on macOS, Linux and Windows.\nconsole.log(${JSON.stringify(layout.output(message))});\n`,
      ),
  };
}

function readme(params: {
  name: string;
  layout: StarterLayout;
  hasScript: boolean;
  shell: StarterShell;
}): string {
  const { name, layout, hasScript, shell } = params;
  const lines = [
    `# ${name}`,
    "",
    `A plugin for ${layout.client}. These starter files are a working example: edit them, or replace them with your own.`,
    "",
    "## What is here",
    "",
    `- \`${layout.manifestPath}\`: the plugin's manifest. It has no \`version\`, because the plugin is versioned on every change where it is published.`,
    `- \`${layout.hooksPath}\`: the plugin's hooks. It has one, which runs when a session starts.`,
    ...(hasScript
      ? [
          "- `scripts/`: the scripts the hooks run. Put your own beside the example.",
        ]
      : []),
    "- `skills/`: one folder per skill, each with a `SKILL.md`.",
    "",
    "## What else the client reads",
    "",
    ...layout.moreFolders.map(([path, what]) => `- \`${path}\`: ${what}`),
    "",
  ];
  if (hasScript && shell === "node") {
    lines.push(
      "## Platforms",
      "",
      "The example hook runs a Node.js script, so that one command works on macOS, Linux and Windows. Node.js has to be installed where the plugin runs.",
      "",
    );
  }
  return lines.join("\n");
}

/** The manifest's `name`: the display name in lowercase with hyphens. */
function starterSlug(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "my-plugin";
}

function text(path: string, content: string): PluginFileDraft {
  return { path, content, encoding: "utf8", mode: "100644" };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
