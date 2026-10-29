import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const scriptPath = path.resolve(
  import.meta.dirname,
  "../../scripts/update-vscode-client-version.mjs",
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runUpdater(source: string, version: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "vscode-client-version-"));
  temporaryDirectories.push(directory);
  const sourcePath = path.join(directory, "github-copilot-token.ts");
  writeFileSync(sourcePath, source);
  const result = spawnSync(
    process.execPath,
    [scriptPath, version, sourcePath],
    {
      encoding: "utf8",
    },
  );
  return { ...result, updatedSource: readFileSync(sourcePath, "utf8") };
}

test("updates only the VS Code version initializer", () => {
  const source = `// GITHUB_COPILOT_VSCODE_VERSION = "9.9.9";
const OTHER_VERSION = "1.99.0";
const GITHUB_COPILOT_VSCODE_VERSION = "1.99.0";
`;
  const result = runUpdater(source, "1.100.0");

  expect(result.status).toBe(0);
  expect(result.updatedSource).toBe(
    source.replace(
      'const GITHUB_COPILOT_VSCODE_VERSION = "1.99.0";',
      'const GITHUB_COPILOT_VSCODE_VERSION = "1.100.0";',
    ),
  );
});

test("updates multiple target files in one invocation", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vscode-client-version-"));
  temporaryDirectories.push(directory);
  const firstPath = path.join(directory, "github-copilot-token.ts");
  const secondPath = path.join(directory, "copilot-cli.ts");
  writeFileSync(firstPath, 'const GITHUB_COPILOT_VSCODE_VERSION = "1.99.0";\n');
  writeFileSync(
    secondPath,
    'const GITHUB_COPILOT_VSCODE_VERSION = "1.99.0";\n',
  );

  const result = spawnSync(
    process.execPath,
    [scriptPath, "1.100.0", firstPath, secondPath],
    { encoding: "utf8" },
  );

  expect(result.status).toBe(0);
  expect(readFileSync(firstPath, "utf8")).toBe(
    'const GITHUB_COPILOT_VSCODE_VERSION = "1.100.0";\n',
  );
  expect(readFileSync(secondPath, "utf8")).toBe(
    'const GITHUB_COPILOT_VSCODE_VERSION = "1.100.0";\n',
  );
});

test.each([
  "1.99.0",
  "1.98.9",
])("leaves the source unchanged for %s", (version) => {
  const source = 'const GITHUB_COPILOT_VSCODE_VERSION = "1.99.0";\n';
  const result = runUpdater(source, version);

  expect(result.status).toBe(0);
  expect(result.updatedSource).toBe(source);
});

test("rejects syntax errors elsewhere in the source file", () => {
  const source =
    'const GITHUB_COPILOT_VSCODE_VERSION = "1.99.0";\nconst broken = ;\n';
  const result = runUpdater(source, "1.100.0");

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("malformed TypeScript source");
  expect(result.updatedSource).toBe(source);
});

test.each([
  "1.100.0-insider",
  "v1.100.0",
  "1.100.0\nnext",
])("rejects an invalid stable version %s", (version) => {
  const source = 'const GITHUB_COPILOT_VSCODE_VERSION = "1.99.0";\n';
  const result = runUpdater(source, version);

  expect(result.status).not.toBe(0);
  expect(result.updatedSource).toBe(source);
});

test.each([
  'const OTHER_VERSION = "1.99.0";\n',
  'const GITHUB_COPILOT_VSCODE_VERSION = "1.99.0";\nconst GITHUB_COPILOT_VSCODE_VERSION = "1.99.0";\n',
  "const GITHUB_COPILOT_VSCODE_VERSION = getVersion();\n",
  'const GITHUB_COPILOT_VSCODE_VERSION = "1.99.0-insider";\n',
])("rejects a missing, ambiguous, or malformed declaration", (source) => {
  const result = runUpdater(source, "1.100.0");

  expect(result.status).not.toBe(0);
  expect(result.updatedSource).toBe(source);
});
