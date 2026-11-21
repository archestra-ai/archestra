import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseShellAssignments, resolveProgram } from "./with-vault-env.mjs";

// The injector's quoting (backend/src/standalone-scripts/vault-env-injector.ee.ts).
const escapeForShell = (value) => `'${value.replace(/'/g, "'\"'\"'")}'`;

const values = {
  PLAIN: "s3cret",
  SPACES: "two words  and more",
  QUOTES: `it's "quoted" ''`,
  SHELLISH: "$HOME `id` $(id) \\n ; | & > <",
  MULTILINE: "-----BEGIN KEY-----\nabc\n\ndef\n-----END KEY-----\n",
  EMPTY: "",
  UNICODE: "pässwörd ✓",
};

test("reads the injector's file exactly as sh sources it", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "vault-env-")), "env");
  const text = `${Object.entries(values)
    .map(([key, value]) => `${key}=${escapeForShell(value)}`)
    .join("\n")}\n`;
  writeFileSync(file, text);

  assert.deepEqual(parseShellAssignments(text), values);

  const fromShell = JSON.parse(
    execFileSync(
      "sh",
      [
        "-c",
        `set -a; . "$1"; set +a; exec node -e 'const k=JSON.parse(process.argv[1]); console.log(JSON.stringify(Object.fromEntries(k.map((n)=>[n,process.env[n]]))))' "$2"`,
        "sh",
        file,
        JSON.stringify(Object.keys(values)),
      ],
      { env: { PATH: process.env.PATH }, encoding: "utf8" },
    ),
  );
  assert.deepEqual(fromShell, values);
});

test("rejects what it cannot read the way sh would, instead of dropping secrets", () => {
  for (const text of [
    "KEY='unterminated",
    'KEY="$HOME"',
    "KEY=$(id)",
    "not an assignment",
    "export KEY='x'",
  ]) {
    assert.throws(() => parseShellAssignments(text), undefined, text);
  }
});

test("skips blank lines and comments", () => {
  assert.deepEqual(parseShellAssignments("\n# note\nA='1'\n\nB=two\n"), {
    A: "1",
    B: "two",
  });
});

test("resolves a program on PATH and keeps a path as given", () => {
  assert.equal(resolveProgram("/app/x", ""), "/app/x");
  assert.equal(resolveProgram("./scripts/x", ""), "./scripts/x");
  assert.equal(
    resolveProgram("node", path.dirname(process.execPath)),
    path.join(path.dirname(process.execPath), "node"),
  );
  assert.throws(() => resolveProgram("no-such-program", "/nonexistent"), /not found/);
});
