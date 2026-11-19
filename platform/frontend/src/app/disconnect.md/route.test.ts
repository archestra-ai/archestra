// @vitest-environment node
import { describe, expect, it } from "vitest";

import { GET } from "./route";

async function read(query: string): Promise<string> {
  const response = GET(
    new Request(`http://localhost:3000/disconnect.md${query}`),
  );
  expect(response.headers.get("Content-Type")).toBe(
    "text/plain; charset=utf-8",
  );
  return response.text();
}

describe("Disconnect agent instructions", () => {
  it("asks for the client when none is given, or it is unknown", async () => {
    for (const query of ["", "?client=unknown"]) {
      const instructions = await read(query);
      expect(instructions).toContain("# Disconnect This Client");
      expect(instructions).toContain(
        "http://localhost:3000/disconnect.md?client=CLIENT_ID",
      );
      expect(instructions).toContain(
        "http://localhost:3000/disconnect.md?client=generic",
      );
    }
  });

  it("proceeds without asking the user to confirm, and backs up what it edits by hand", async () => {
    for (const client of [
      "claude-code",
      "codex",
      "copilot-cli",
      "opencode",
      "cursor",
      "claude-desktop",
      "kilo",
      "generic",
    ]) {
      const instructions = await read(`?client=${client}`);
      expect(instructions).toContain(
        "Do not show a plan first and do not\nask them to confirm",
      );
      expect(instructions).not.toMatch(/wait for the user|explicit yes/);
      expect(instructions).toContain("## 2. Disconnect");
      expect(instructions).toContain("<file>.before-disconnect");
      expect(instructions).toContain(
        "http://localhost:3000/connection and press Revoke access",
      );
    }
  });

  it("lets a client's startup check undo its own setup", async () => {
    const instructions = await read("?client=claude-code");
    expect(instructions).toContain(
      "ARCHESTRA_GUARD_ACTION=disconnect bash ~/.archestra/claude-startup-guard.sh",
    );
    expect(instructions).toContain(
      `$env:ARCHESTRA_GUARD_ACTION='disconnect'; try { & "$HOME\\.archestra\\claude-startup-guard.ps1" }`,
    );
    expect(instructions).toContain(
      "claude mcp remove --scope user SERVER_NAME",
    );
    expect(instructions).toContain(
      'Delete the "# >>> archestra claude guard >>>" through',
    );
  });

  it("matches config entries on the connection base URL the user picked", async () => {
    const instructions = await read(
      "?client=cursor&base=https://api.example.com/v1/",
    );
    expect(instructions).toContain(
      "whose URL starts with https://api.example.com/v1/mcp/",
    );
    expect(instructions).toContain(
      "git clone of https://api.example.com/skills/",
    );
    expect(instructions).toContain(
      "Only touch entries that point at https://api.example.com;",
    );
  });

  it("has Cursor's own cleanup helper remove everything its setup added", async () => {
    const instructions = await read("?client=cursor");
    // Every part the Cursor setup writes is named, so an agent without the
    // helper can still find it.
    for (const part of [
      "whose URL starts with http://localhost:3000/v1/mcp/",
      ".cursor/archestra/web-tools.mjs",
      ".cursor/archestra/guardrails-hook.mjs",
      "~/.cursor/permissions.json",
      "~/.cursor/archestra/",
      "git clone of http://localhost:3000/skills/",
      "Web Search Tool and Web Fetch Tool",
      "~/.cursor/projects/FOLDER/mcp-auth.json",
    ]) {
      expect(instructions).toContain(part);
    }
    expect(instructions).toContain(
      'then node "$HOME/.cursor/archestra/disconnect.cjs"; else',
    );
    expect(instructions).toContain(
      '{ node "$HOME\\.cursor\\archestra\\disconnect.cjs"; if ($LASTEXITCODE',
    );
    // The report leaves the user two things to do, and no checklist.
    expect(instructions).toContain(
      "1. Quit and reopen Cursor.\n2. Open http://localhost:3000/connection and press Revoke access in the Disconnect dialog.",
    );
    expect(instructions).not.toMatch(
      /User Rules|Customize > Plugins|Customize > MCPs/,
    );
    // The chat's run finishes by itself when Cursor next closes.
    expect(instructions).not.toContain("--wait");
    expect(instructions).toContain("they have nothing to run");
    // Cursor's own apps stay: the user may go on using them.
    expect(instructions).toContain(
      "never uninstall it and never run its logout",
    );
    expect(instructions).not.toContain("--keep-cli");
    // What other apps installed is reported, not removed.
    expect(instructions).toContain("~/.claude/plugins/");
    expect(instructions).toContain("Leave them as\nthey are.");
  });

  it("tells every agent not to put an entry back when Guardrails block a step", async () => {
    for (const client of ["claude-code", "cursor", "generic"]) {
      const instructions = await read(`?client=${client}`);
      expect(instructions).toContain(
        "never put a removed entry back to get\nan approval",
      );
      expect(instructions).toContain("Remove the gateway's MCP entry last.");
    }
  });

  it("ignores a base that is not an http URL", async () => {
    const instructions = await read("?client=codex&base=javascript:alert(1)");
    expect(instructions).toContain("starts with http://localhost:3000/v1/mcp/");
    expect(instructions).not.toContain("javascript:");
  });

  it("removes the Claude Desktop managed profile on the host only", async () => {
    const instructions = await read("?client=claude-desktop");
    expect(instructions).toContain(
      "configLibrary/aa157426-f6a9-5ac5-8471-3b30b42bbe8f.json",
    );
    expect(instructions).toContain("do not change anything there");
    expect(instructions).toContain("Do not force it to close.");
  });

  it("undoes Kilo Code's setup in its own config, plugin and skills folders", async () => {
    const instructions = await read("?client=kilo");
    expect(instructions).toContain("# Disconnect Kilo Code");
    expect(instructions).toContain(
      "ARCHESTRA_GUARD_ACTION=disconnect bash ~/.archestra/kilo-startup-guard.sh",
    );
    expect(instructions).toContain("~/.config}/kilo/kilo.json");
    expect(instructions).toContain("kilo mcp logout SERVER_NAME");
    expect(instructions).toContain(
      "~/.archestra/kilo-routing-plugin-state.json",
    );
    expect(instructions).not.toContain("opencode");
  });
});
