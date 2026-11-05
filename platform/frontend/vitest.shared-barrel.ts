import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Plugin } from "vitest/config";

/**
 * Rewrites named imports from the `@archestra/shared` barrel to the module
 * that defines each export, for the test run only. The barrel re-exports
 * about ninety modules (schemas, the generated API client, utilities), and
 * a test file that needs one constant evaluated all of them: with each file
 * importing the app again under its own mocks, that was a fixed cost on
 * every file. Next does the same for the app through optimizePackageImports.
 *
 * A module mock must therefore name the module that defines what it
 * replaces, such as `@archestra/shared/api-sdk` for `archestraApiSdk`; a
 * mock of `@archestra/shared` no longer reaches code that imports from it.
 */
export function sharedBarrelImports(barrelFile: string): Plugin {
  const targets = collectExports(barrelFile, new Set());
  return {
    name: "archestra:shared-barrel-imports",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0] ?? id;
      if (!code.includes(`"${BARREL}"`)) return null;
      if (file.includes("/node_modules/") || !SOURCE_FILE.test(file)) {
        return null;
      }
      const rewritten = rewriteImports({ code, file, targets });
      return rewritten === code ? null : { code: rewritten, map: null };
    },
  };
}

// ===== Internal helpers =====

const BARREL = "@archestra/shared";
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

interface ExportTarget {
  file: string;
  name: string;
  namespace: boolean;
}

/** Every value export of a module, keyed by name, with where it is defined. */
function collectExports(
  file: string,
  visiting: Set<string>,
): Map<string, ExportTarget> {
  const targets = new Map<string, ExportTarget>();
  if (visiting.has(file)) return targets;
  visiting.add(file);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const starTargets: Map<string, ExportTarget>[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const from = statement.moduleSpecifier
        ? resolveRelative(
            file,
            (statement.moduleSpecifier as ts.StringLiteral).text,
          )
        : file;
      if (!from) continue;
      const clause = statement.exportClause;
      if (!clause) {
        starTargets.push(collectExports(from, visiting));
      } else if (ts.isNamespaceExport(clause)) {
        targets.set(clause.name.text, {
          file: from,
          name: clause.name.text,
          namespace: true,
        });
      } else {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          targets.set(element.name.text, {
            file: from,
            name:
              from === file
                ? element.name.text
                : (element.propertyName ?? element.name).getText(source),
            namespace: false,
          });
        }
      }
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    for (const name of declaredValueNames(statement)) {
      targets.set(name, { file, name, namespace: false });
    }
  }
  // Explicit exports win over `export *`, as in the module itself.
  for (const star of starTargets) {
    for (const [name, target] of star) {
      if (!targets.has(name)) targets.set(name, target);
    }
  }
  return targets;
}

function rewriteImports(params: {
  code: string;
  file: string;
  targets: Map<string, ExportTarget>;
}): string {
  const { code, file, targets } = params;
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const edits: { start: number; end: number; text: string }[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      (statement.moduleSpecifier as ts.StringLiteral).text !== BARREL
    ) {
      continue;
    }
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (
      !clause ||
      clause.isTypeOnly ||
      clause.name ||
      !bindings ||
      !ts.isNamedImports(bindings)
    ) {
      continue;
    }
    const byFile = new Map<string, string[]>();
    const namespaces: string[] = [];
    const kept: string[] = [];
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).getText(source);
      const local = element.name.text;
      const target = element.isTypeOnly ? undefined : targets.get(imported);
      if (!target) {
        kept.push(element.getText(source));
      } else if (target.namespace) {
        namespaces.push(`import * as ${local} from "${target.file}";`);
      } else {
        const names = byFile.get(target.file) ?? [];
        names.push(
          target.name === local ? local : `${target.name} as ${local}`,
        );
        byFile.set(target.file, names);
      }
    }
    if (kept.length === bindings.elements.length) continue;
    const imports = [
      ...namespaces,
      ...[...byFile].map(
        ([target, names]) => `import { ${names.join(", ")} } from "${target}";`,
      ),
      ...(kept.length
        ? [`import { ${kept.join(", ")} } from "${BARREL}";`]
        : []),
    ];
    const start = statement.getStart(source);
    const end = statement.getEnd();
    // Keep the line count, so stack traces still point at the right lines.
    const lines = code.slice(start, end).split("\n").length - 1;
    edits.push({ start, end, text: imports.join(" ") + "\n".repeat(lines) });
  }
  let rewritten = code;
  for (const edit of edits.reverse()) {
    rewritten =
      rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }
  return rewritten;
}

function hasExportModifier(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) &&
    !(ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
    )
  );
}

function declaredValueNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return [statement.name.text];
  }
  return [];
}

function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [
    base,
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    if (SOURCE_FILE.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}
