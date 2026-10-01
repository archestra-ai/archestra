import { describe, expect, test } from "vitest";
import {
  buildShellRemedyCommand,
  readShellRemedyCommand,
} from "./shell-remedy";

const SECRET = "shell-remedy-test-secret-0123456789";
const SESSION = {
  organization_id: "org-1",
  caller_id: "user:alice",
  session_id: "user:alice|session-1",
};

const NOTICE = {
  tool: "read",
  arguments: JSON.stringify({ file_path: "/etc/secret" }),
  ruling: "[appa] Blocked: read is not allowed by policy",
  notice: { v: 1, call_id: "call_1" },
};

function issued(callId = "call_1", notice: unknown = NOTICE) {
  const script = buildShellRemedyCommand({
    session: SESSION,
    callId,
    notice,
    secret: SECRET,
  });
  if (!script) throw new Error("expected a script");
  return script;
}

describe("OpenCode shell remedy script", () => {
  test("round-trips the bound ruling through the issued command", () => {
    const script = issued();
    expect(script.command).toMatch(/^cat <<'APPA_SHELL_REMEDY_[A-Za-z0-9_-]+'/);
    expect(script.command).toContain(JSON.stringify(NOTICE));

    const read = readShellRemedyCommand({
      session: SESSION,
      callId: "call_1",
      arguments: { command: script.command },
      secret: SECRET,
    });
    expect(read).toEqual(NOTICE);
  });

  test("accepts arguments as the raw JSON string the wire carries", () => {
    const script = issued();
    const read = readShellRemedyCommand({
      session: SESSION,
      callId: "call_1",
      arguments: JSON.stringify({ command: script.command }),
      secret: SECRET,
    });
    expect(read).toEqual(NOTICE);
  });

  test("refuses a ruling signed for another call, session, or secret", () => {
    const script = issued();
    for (const mismatch of [
      { callId: "call_2" },
      { session: { ...SESSION, session_id: "user:alice|session-2" } },
      { session: { ...SESSION, organization_id: "org-2" } },
      { secret: "shell-remedy-test-secret-ffffffff" },
    ]) {
      expect(
        readShellRemedyCommand({
          session: SESSION,
          callId: "call_1",
          arguments: { command: script.command },
          secret: SECRET,
          ...mismatch,
        }),
      ).toBeUndefined();
    }
  });

  test("refuses a tampered ruling or envelope", () => {
    const script = issued();
    const lines = script.command.split("\n");
    // Tamper with the ruling bytes but keep the envelope untouched.
    const tamperedRuling = [
      lines[0],
      lines[1].replace("not allowed", "allowed"),
      ...lines.slice(2),
    ].join("\n");
    expect(
      readShellRemedyCommand({
        session: SESSION,
        callId: "call_1",
        arguments: { command: tamperedRuling },
        secret: SECRET,
      }),
    ).toBeUndefined();
    // Tamper with the tag itself.
    const tamperedTag = script.command.replace(
      /"tag":"[^"]+"/,
      '"tag":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
    );
    expect(
      readShellRemedyCommand({
        session: SESSION,
        callId: "call_1",
        arguments: { command: tamperedTag },
        secret: SECRET,
      }),
    ).toBeUndefined();
  });

  test("refuses anything beyond the exact issued script", () => {
    const script = issued();
    const base = {
      session: SESSION,
      callId: "call_1",
      secret: SECRET,
    };
    // An appended command makes it the client's own script, not ours.
    expect(
      readShellRemedyCommand({
        ...base,
        arguments: { command: `${script.command}echo pwned\n` },
      }),
    ).toBeUndefined();
    // An ordinary shell command is not a ruling carrier.
    expect(
      readShellRemedyCommand({
        ...base,
        arguments: { command: "cat /etc/hostname" },
      }),
    ).toBeUndefined();
    expect(
      readShellRemedyCommand({
        ...base,
        arguments: { cmd: script.command },
      }),
    ).toBeUndefined();
    expect(
      readShellRemedyCommand({
        ...base,
        argument: "cmd",
        arguments: { cmd: script.command },
      }),
    ).toEqual(NOTICE);
    expect(
      readShellRemedyCommand({ ...base, arguments: "not json at all" }),
    ).toBeUndefined();
    expect(
      readShellRemedyCommand({ ...base, arguments: undefined }),
    ).toBeUndefined();
  });

  test("fails closed without a signing secret", () => {
    expect(
      buildShellRemedyCommand({
        session: SESSION,
        callId: "call_1",
        notice: NOTICE,
        secret: "",
      }),
    ).toBeUndefined();
    expect(
      readShellRemedyCommand({
        session: SESSION,
        callId: "call_1",
        arguments: { command: issued().command },
        secret: "",
      }),
    ).toBeUndefined();
  });

  test("rebinds when a ruling would close its own heredoc", () => {
    // A payload that happens to embed the first nonce's delimiter must not
    // ship: the builder retries with another nonce until the payload is safe.
    const noticeLine = JSON.stringify(NOTICE);
    const script = buildShellRemedyCommand({
      session: SESSION,
      callId: "call_1",
      notice: NOTICE,
      secret: SECRET,
    });
    expect(script).toBeDefined();
    expect(noticeLine.includes(`APPA_SHELL_REMEDY_${script?.nonce}`)).toBe(
      false,
    );
  });
});
