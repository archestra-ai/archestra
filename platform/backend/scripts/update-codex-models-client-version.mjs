import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const tag = process.argv[2];
const sourcePath =
  process.argv[3] ??
  fileURLToPath(
    new URL("../src/routes/chat/model-fetchers/openai.ts", import.meta.url),
  );

if (!/^rust-v\d+\.\d+\.\d+$/.test(tag ?? "")) {
  throw new Error(`Expected a stable Codex release tag, received: ${tag}`);
}

const nextVersion = tag.slice("rust-v".length);
const sourceText = readFileSync(sourcePath, "utf8");
const sourceFile = ts.createSourceFile(
  sourcePath,
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
if (sourceFile.parseDiagnostics.length > 0) {
  const error = sourceFile.parseDiagnostics[0];
  throw new Error(
    `Cannot update malformed TypeScript source: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`,
  );
}
const declarations = sourceFile.statements.flatMap((statement) =>
  ts.isVariableStatement(statement)
    ? statement.declarationList.declarations.filter(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "CODEX_MODELS_CLIENT_VERSION",
      )
    : [],
);

if (
  declarations.length !== 1 ||
  !declarations[0].initializer ||
  !ts.isStringLiteral(declarations[0].initializer)
) {
  throw new Error("Expected exactly one Codex client version string declaration");
}

const currentVersion = declarations[0].initializer.text;
if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) {
  throw new Error(`Invalid current Codex client version: ${currentVersion}`);
}

const currentParts = currentVersion.split(".").map(BigInt);
const nextParts = nextVersion.split(".").map(BigInt);
const nextIsNewer = nextParts.some((part, index) => {
  const priorPartsEqual = nextParts
    .slice(0, index)
    .every((prior, priorIndex) => prior === currentParts[priorIndex]);
  return priorPartsEqual && part > currentParts[index];
});

if (!nextIsNewer) {
  process.stdout.write(`Codex client version remains ${currentVersion}\n`);
  process.exit(0);
}

const initializer = declarations[0].initializer;
const updatedText =
  sourceText.slice(0, initializer.getStart(sourceFile)) +
  JSON.stringify(nextVersion) +
  sourceText.slice(initializer.getEnd());
writeFileSync(sourcePath, updatedText);
process.stdout.write(`Updated Codex client version ${currentVersion} -> ${nextVersion}\n`);
