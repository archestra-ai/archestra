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

  it("waits for the user's yes and backs up before changing anything", async () => {
    for (const client of [
      "claude-code",
      "codex",
      "copilot-cli",
      "opencode",
      "droid",
      "cursor",
      "claude-desktop",
      "generic",
    ]) {
      const instructions = await read(`?client=${client}`);
      expect(instructions).toContain("## 2. Show the plan and wait");
      expect(instructions).toContain("wait for the user's explicit yes");
      expect(instructions).toContain("<file>.before-disconnect");
      expect(instructions).toContain(
        "go back to http://localhost:3000/connection and press Revoke access",
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
});
