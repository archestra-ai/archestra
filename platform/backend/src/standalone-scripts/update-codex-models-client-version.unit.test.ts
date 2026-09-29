import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const scriptPath = path.resolve(
  import.meta.dirname,
  "../../scripts/update-codex-models-client-version.mjs",
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runUpdater(source: string, tag: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-client-version-"));
  temporaryDirectories.push(directory);
  const sourcePath = path.join(directory, "openai.ts");
  writeFileSync(sourcePath, source);
  const result = spawnSync(process.execPath, [scriptPath, tag, sourcePath], {
    encoding: "utf8",
  });
  return { ...result, updatedSource: readFileSync(sourcePath, "utf8") };
}

test("updates only the Codex version initializer", () => {
  const source = `// CODEX_MODELS_CLIENT_VERSION = "9.9.9";
const OTHER_VERSION = "0.158.0";
const CODEX_MODELS_CLIENT_VERSION = "0.158.0";
`;
  const result = runUpdater(source, "rust-v0.159.0");

  expect(result.status).toBe(0);
  expect(result.updatedSource).toBe(
    source.replace(
      'const CODEX_MODELS_CLIENT_VERSION = "0.158.0";',
      'const CODEX_MODELS_CLIENT_VERSION = "0.159.0";',
    ),
  );
});

test.each([
  "rust-v0.158.0",
  "rust-v0.157.9",
])("leaves the source unchanged for %s", (tag) => {
  const source = 'const CODEX_MODELS_CLIENT_VERSION = "0.158.0";\n';
  const result = runUpdater(source, tag);

  expect(result.status).toBe(0);
  expect(result.updatedSource).toBe(source);
});

test("rejects syntax errors elsewhere in the source file", () => {
  const source =
    'const CODEX_MODELS_CLIENT_VERSION = "0.158.0";\nconst broken = ;\n';
  const result = runUpdater(source, "rust-v0.159.0");

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("malformed TypeScript source");
  expect(result.updatedSource).toBe(source);
});

test.each([
  "rust-v0.159.0-alpha.1",
  "v0.159.0",
  "rust-v0.159.0\nnext",
])("rejects an invalid stable release tag %s", (tag) => {
  const source = 'const CODEX_MODELS_CLIENT_VERSION = "0.158.0";\n';
  const result = runUpdater(source, tag);

  expect(result.status).not.toBe(0);
  expect(result.updatedSource).toBe(source);
});

test.each([
  'const OTHER_VERSION = "0.158.0";\n',
  'const CODEX_MODELS_CLIENT_VERSION = "0.158.0";\nconst CODEX_MODELS_CLIENT_VERSION = "0.158.0";\n',
  "const CODEX_MODELS_CLIENT_VERSION = getVersion();\n",
  'const CODEX_MODELS_CLIENT_VERSION = "0.158.0-alpha.1";\n',
])("rejects a missing, ambiguous, or malformed declaration", (source) => {
  const result = runUpdater(source, "rust-v0.159.0");

  expect(result.status).not.toBe(0);
  expect(result.updatedSource).toBe(source);
});
