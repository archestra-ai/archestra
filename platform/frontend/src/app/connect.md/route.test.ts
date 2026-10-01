// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { GET } from "./route";

const execFileAsync = promisify(execFile);

describe("Connect agent instructions", () => {
  it("keeps the full instructions when no client is specified", async () => {
    const response = GET(new Request("http://localhost:3000/connect.md"));
    const instructions = await response.text();

    expect(instructions).toContain("## Claude Desktop");
    expect(instructions).toContain("OpenCode: run opencode mcp list first.");
    expect(instructions).toContain(
      "Cursor: installation alone is not a complete connection.",
    );
    expect(instructions).toContain(
      "the skills check, or proxy inference remain unverified, say so explicitly.",
    );
    expect(instructions).toContain(
      "their own OpenAI API key in Cursor Settings; never ask for the key in chat.",
    );
    expect(instructions).toContain(
      'find "Cursor model settings (manual step)"',
    );
    expect(instructions).toContain(
      "curl --fail --silent --show-error http://localhost:3000/api/client-connections/installer",
    );
    expect(instructions).toContain("trap 'unlink \"$p\"' EXIT");
    expect(instructions).not.toContain("rm -f");
  });

  it("focuses Cursor instructions on its own setup and native checks", async () => {
    const response = GET(
      new Request("http://localhost:3000/connect.md?client=cursor"),
    );
    const instructions = await response.text();

    expect(instructions).toContain("# Connect Cursor");
    expect(instructions).toContain("--client cursor");
    expect(instructions).toContain("Customize > MCPs");
    expect(instructions).toContain("Customize > Skills");
    expect(instructions).toContain("Cursor model settings (manual step)");
    expect(instructions).toContain("printed virtual key");
    expect(instructions).toContain(
      "otherwise they need their own OpenAI API key",
    );
    expect(instructions).toContain("A Cursor subscription cannot authenticate");
    expect(instructions).not.toContain("Claude Desktop");
    expect(instructions).not.toContain("opencode mcp auth");
  });

  it.each([
    "",
    "?client=codex",
  ])("keeps a yielded Codex installer on the same session in %s", async (query) => {
    const instructions = await GET(
      new Request(`http://localhost:3000/connect.md${query}`),
    ).text();
    expect(instructions).toContain(
      "keep reading that same session with write_stdin",
    );
    expect(instructions).toContain('prints "Browser approval confirmed."');
    expect(instructions).toContain(
      "Do not end the turn and ask the user to say when approval is finished.",
    );
    expect(instructions).toContain(
      "Do not print the approval URL again if this session already printed it.",
    );
    expect(instructions).toContain(
      "Do not start a second installer while that process is alive.",
    );
    expect(instructions).toContain("Keep the first request and its code.");
    expect(instructions).toContain(
      "Gateway OAuth is a later native sign-in after this installer applies the setup.",
    );
    expect(instructions).toContain("It is not a new connection approval.");
    expect(instructions).not.toContain("approval_policy");
  });

  it("does not tell other clients to poll a Codex session", async () => {
    const instructions = await GET(
      new Request("http://localhost:3000/connect.md?client=cursor"),
    ).text();
    expect(instructions).not.toContain("write_stdin");
  });

  it.each([
    "",
    "?client=codex",
  ])("does not repeat completed Codex OAuth in %s instructions", async (query) => {
    const instructions = await GET(
      new Request(`http://localhost:3000/connect.md${query}`),
    ).text();
    expect(instructions).toContain(
      "gateway OAuth is already cached. Do not run codex mcp login again",
    );
    expect(instructions).toContain("If auth_status is oauth, skip login");
    expect(instructions).toContain(
      "Only if auth_status is not_logged_in, run codex mcp login SERVER_NAME once",
    );
    expect(instructions).toContain(
      "Do not ask the user to run verification commands",
    );
    expect(instructions).not.toContain("run codex mcp login SERVER_NAME, then");
    expect(instructions).not.toContain("Run codex mcp login SERVER_NAME, then");
  });

  it.each([
    ["claude-code", "Claude Code", "--client claude-code"],
    ["codex", "Codex", "--client codex"],
    ["copilot-cli", "Copilot CLI", "--client copilot-cli"],
    ["opencode", "OpenCode", "--client opencode"],
  ])("focuses %s instructions", async (client, label, command) => {
    const response = GET(
      new Request(`http://localhost:3000/connect.md?client=${client}`),
    );
    const instructions = await response.text();

    expect(instructions).toContain(`# Connect ${label}`);
    expect(instructions).toContain(command);
    expect(instructions).toContain("trap 'unlink \"$p\"' EXIT");
    expect(instructions).not.toContain("rm -f");
    expect(instructions).not.toContain("## Claude Desktop");
    expect(instructions).not.toContain("Cursor subscription");
    if (client === "codex") {
      expect(instructions).toContain(
        "Report the connection status briefly without listing tool names or quoting the test response.",
      );
    }
  });

  it.each([
    "",
    "?client=codex",
  ])("uses the deterministic native verifier in %s instructions", async (query) => {
    const instructions = await GET(
      new Request(`http://localhost:3000/connect.md${query}`),
    ).text();
    expect(instructions).toContain(
      "run the exact Verification command printed by the installer yourself",
    );
    expect(instructions).toContain(
      "Do not substitute codex exec or a model-driven shell probe",
    );
    expect(instructions).toContain(
      "configured model, approval mode and sandbox unchanged",
    );
    expect(instructions).toContain(
      "Report success only when the helper returns verified",
    );
    expect(instructions).toContain("printed native PowerShell verifier");
    expect(instructions).toContain("ordinary native per-command approval");
    expect(instructions).toContain("retry once");
    expect(instructions).toContain(
      "never auto-approve app-server permission requests",
    );
  });

  it("runs the Codex installer command and cleans only its temporary script", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-connect-"));
    const resultFile = join(directory, "result.json");
    const server = createServer((request, response) => {
      if (request.url !== "/api/client-connections/installer") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/javascript" });
      response.end(
        `require('node:fs').writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(process.argv.slice(2)))`,
      );
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected installer test server port");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const instructions = await GET(
        new Request(`${origin}/connect.md?client=codex`),
      ).text();
      const command = instructions.match(/macOS\/Linux:\n([^\n]+)/)?.[1];
      if (!command) throw new Error("Missing macOS/Linux installer command");
      await execFileAsync("bash", ["-c", command], {
        env: { ...process.env, TMPDIR: directory },
      });
      expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual([
        "--url",
        origin,
        "--client",
        "codex",
      ]);
      expect(await readdir(directory)).toEqual(["result.json"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "http://localhost:3000/connect.md",
    "http://localhost:3000/connect.md?client=opencode",
  ])("leaves the OpenCode restart to the user in %s", async (url) => {
    const instructions = await GET(new Request(url)).text();
    expect(instructions).toContain(
      "Do not stop or restart OpenCode from inside this conversation",
    );
    expect(instructions).toContain(
      "ask the user to save work, close OpenCode normally",
    );
    expect(instructions).not.toContain("Close every OpenCode process");
  });

  it.each([
    "http://localhost:3000/connect.md",
    "http://localhost:3000/connect.md?client=codex",
  ])("keeps the bootstrap cleanup compatible with Codex direct tools in %s", async (url) => {
    const instructions = await GET(new Request(url)).text();
    expect(instructions).toContain("trap 'unlink \"$p\"' EXIT");
    expect(instructions).not.toContain("trap 'rm -f \"$p\"' EXIT");
    expect(instructions).toContain("or quoting the test response");
  });

  it("focuses Claude Desktop on its host installer", async () => {
    const response = GET(
      new Request("http://localhost:3000/connect.md?client=claude-desktop"),
    );
    const instructions = await response.text();

    expect(instructions).toContain("# Connect Claude Desktop");
    expect(instructions).toContain("/connection?clientId=claude-desktop");
    expect(instructions).not.toContain("--client CLIENT_ID");
    expect(instructions).not.toContain("opencode mcp auth");
  });

  it("keeps the full instructions for an unknown client", async () => {
    const response = GET(
      new Request("http://localhost:3000/connect.md?client=unknown"),
    );
    expect(await response.text()).toContain("## Claude Desktop");
  });
});
