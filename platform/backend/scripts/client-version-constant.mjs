import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

/**
 * Raises one top-level `const <identifier> = "X.Y.Z"` declaration to
 * `nextVersion` when that version is newer, and leaves the source unchanged
 * otherwise. `format: "date"` takes `YYYY-MM-DD` versions instead (API
 * versions such as `X-GitHub-Api-Version`). The scheduled client-version
 * workflows call this through their update scripts. Throws on malformed
 * source, or on a missing, ambiguous, or non-literal declaration.
 */
export function updateClientVersionConstant({
  sourcePath,
  identifier,
  nextVersion,
  label,
  format = "semver",
}) {
  const { pattern, isNewer } = VERSION_FORMATS[format];
  if (!pattern.test(nextVersion)) {
    throw new Error(`Invalid next ${label}: ${nextVersion}`);
  }
  const sourceText = readFileSync(sourcePath, "utf8");
  // The public transpile API reports syntax errors. `SourceFile.parseDiagnostics`
  // gives the same errors, but it is internal to TypeScript.
  const { diagnostics = [] } = ts.transpileModule(sourceText, {
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  if (diagnostics.length > 0) {
    throw new Error(
      `Cannot update malformed TypeScript source: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n")}`,
    );
  }
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
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
  if (!pattern.test(currentVersion)) {
    throw new Error(`Invalid current ${label}: ${currentVersion}`);
  }

  if (!isNewer(nextVersion, currentVersion)) {
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

const VERSION_FORMATS = {
  semver: {
    pattern: /^\d+\.\d+\.\d+$/,
    isNewer(next, current) {
      const currentParts = current.split(".").map(BigInt);
      const nextParts = next.split(".").map(BigInt);
      return nextParts.some((part, index) => {
        const priorPartsEqual = nextParts
          .slice(0, index)
          .every((prior, priorIndex) => prior === currentParts[priorIndex]);
        return priorPartsEqual && part > currentParts[index];
      });
    },
  },
  // Zero-padded dates order as strings.
  date: {
    pattern: /^\d{4}-\d{2}-\d{2}$/,
    isNewer: (next, current) => next > current,
  },
};
