import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const scriptPath = path.resolve(
  import.meta.dirname,
  "../../scripts/update-grok-client-version.mjs",
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runUpdater(source: string, version: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "grok-client-version-"));
  temporaryDirectories.push(directory);
  const sourcePath = path.join(directory, "xai-subscription-token.ts");
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

test("updates only the Grok CLI version initializer", () => {
  const source = `// GROK_CLI_CLIENT_VERSION = "9.9.9";
const OTHER_VERSION = "1.0.46";
const GROK_CLI_CLIENT_VERSION = "1.0.46";
`;
  const result = runUpdater(source, "1.0.47");

  expect(result.status).toBe(0);
  expect(result.updatedSource).toBe(
    source.replace(
      'const GROK_CLI_CLIENT_VERSION = "1.0.46";',
      'const GROK_CLI_CLIENT_VERSION = "1.0.47";',
    ),
  );
});

test.each([
  "1.0.46",
  "1.0.45",
])("leaves the source unchanged for %s", (version) => {
  const source = 'const GROK_CLI_CLIENT_VERSION = "1.0.46";\n';
  const result = runUpdater(source, version);

  expect(result.status).toBe(0);
  expect(result.updatedSource).toBe(source);
});

test.each([
  "1.0.47-alpha.1",
  "v1.0.47",
  "1.0.47\nnext",
  "<html>",
])("rejects an invalid stable version %s", (version) => {
  const source = 'const GROK_CLI_CLIENT_VERSION = "1.0.46";\n';
  const result = runUpdater(source, version);

  expect(result.status).not.toBe(0);
  expect(result.updatedSource).toBe(source);
});

test.each([
  'const OTHER_VERSION = "1.0.46";\n',
  'const GROK_CLI_CLIENT_VERSION = "1.0.46";\nconst GROK_CLI_CLIENT_VERSION = "1.0.46";\n',
  "const GROK_CLI_CLIENT_VERSION = getVersion();\n",
])("rejects a missing, ambiguous, or malformed declaration", (source) => {
  const result = runUpdater(source, "1.0.47");

  expect(result.status).not.toBe(0);
  expect(result.updatedSource).toBe(source);
});
