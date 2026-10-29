import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const scriptPath = path.resolve(
  import.meta.dirname,
  "../../scripts/update-copilot-chat-client-version.mjs",
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runUpdater(source: string, tag: string) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "copilot-chat-client-version-"),
  );
  temporaryDirectories.push(directory);
  const sourcePath = path.join(directory, "github-copilot-token.ts");
  writeFileSync(sourcePath, source);
  const result = spawnSync(process.execPath, [scriptPath, tag, sourcePath], {
    encoding: "utf8",
  });
  return { ...result, updatedSource: readFileSync(sourcePath, "utf8") };
}

test("updates only the Copilot Chat version initializer", () => {
  const source = `// GITHUB_COPILOT_CHAT_VERSION = "9.9.9";
const OTHER_VERSION = "0.26.7";
const GITHUB_COPILOT_CHAT_VERSION = "0.26.7";
`;
  const result = runUpdater(source, "v0.27.0");

  expect(result.status).toBe(0);
  expect(result.updatedSource).toBe(
    source.replace(
      'const GITHUB_COPILOT_CHAT_VERSION = "0.26.7";',
      'const GITHUB_COPILOT_CHAT_VERSION = "0.27.0";',
    ),
  );
});

test.each([
  "v0.26.7",
  "v0.26.6",
])("leaves the source unchanged for %s", (tag) => {
  const source = 'const GITHUB_COPILOT_CHAT_VERSION = "0.26.7";\n';
  const result = runUpdater(source, tag);

  expect(result.status).toBe(0);
  expect(result.updatedSource).toBe(source);
});

test("rejects syntax errors elsewhere in the source file", () => {
  const source =
    'const GITHUB_COPILOT_CHAT_VERSION = "0.26.7";\nconst broken = ;\n';
  const result = runUpdater(source, "v0.27.0");

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("malformed TypeScript source");
  expect(result.updatedSource).toBe(source);
});

test.each([
  "v0.27.0-alpha.1",
  "v0.43.2026040705",
  "0.27.0",
  "v0.27.0\nnext",
])("rejects an invalid stable release tag %s", (tag) => {
  const source = 'const GITHUB_COPILOT_CHAT_VERSION = "0.26.7";\n';
  const result = runUpdater(source, tag);

  expect(result.status).not.toBe(0);
  expect(result.updatedSource).toBe(source);
});

test.each([
  'const OTHER_VERSION = "0.26.7";\n',
  'const GITHUB_COPILOT_CHAT_VERSION = "0.26.7";\nconst GITHUB_COPILOT_CHAT_VERSION = "0.26.7";\n',
  "const GITHUB_COPILOT_CHAT_VERSION = getVersion();\n",
  'const GITHUB_COPILOT_CHAT_VERSION = "0.26.7-alpha.1";\n',
])("rejects a missing, ambiguous, or malformed declaration", (source) => {
  const result = runUpdater(source, "v0.27.0");

  expect(result.status).not.toBe(0);
  expect(result.updatedSource).toBe(source);
});
