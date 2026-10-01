import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

/**
 * Raises one top-level `const <identifier> = "X.Y.Z"` declaration to
 * `nextVersion` when that version is newer, and leaves the source unchanged
 * otherwise. The scheduled client-version workflows call this through their
 * update scripts. Throws on malformed source, or on a missing, ambiguous, or
 * non-literal declaration.
 */
export function updateClientVersionConstant({
  sourcePath,
  identifier,
  nextVersion,
  label,
}) {
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
            declaration.name.text === identifier,
        )
      : [],
  );

  if (
    declarations.length !== 1 ||
    !declarations[0].initializer ||
    !ts.isStringLiteral(declarations[0].initializer)
  ) {
    throw new Error(`Expected exactly one ${label} string declaration`);
  }

  const currentVersion = declarations[0].initializer.text;
  if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) {
    throw new Error(`Invalid current ${label}: ${currentVersion}`);
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
    process.stdout.write(`${label} remains ${currentVersion}\n`);
    return;
  }

  const initializer = declarations[0].initializer;
  const updatedText =
    sourceText.slice(0, initializer.getStart(sourceFile)) +
    JSON.stringify(nextVersion) +
    sourceText.slice(initializer.getEnd());
  writeFileSync(sourcePath, updatedText);
  process.stdout.write(`Updated ${label} ${currentVersion} -> ${nextVersion}\n`);
}
