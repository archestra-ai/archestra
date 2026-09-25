import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const sourceRoot = path.resolve(import.meta.dirname, "../");
const fixtureFile = path.join(sourceRoot, "test/fixtures.ts");
const fixtureSource = ts.createSourceFile(
  fixtureFile,
  readFileSync(fixtureFile, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const fixtureInterface = fixtureSource.statements.find(
  (statement): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) &&
    statement.name.text === "TestFixtures",
);

if (!fixtureInterface) {
  throw new Error("TestFixtures interface was not found");
}

const fixtureNames = new Set(
  fixtureInterface.members.map((member) => member.name?.getText(fixtureSource)),
);
const unnecessaryImports: string[] = [];

for (const file of testFiles(sourceRoot)) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const importsFixtureTest = source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@/test",
  );
  const usesRouteFixtures = source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return false;
    }
    const moduleName = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          (moduleName === "@/test/route-test-app" &&
            element.name.text === "useRouteTestApp") ||
          (moduleName === "./skill.test-helpers" &&
            element.name.text === "useSkillRouteTestApp"),
      )
    );
  });
  if (importsFixtureTest && !usesFixture(source) && !usesRouteFixtures) {
    unnecessaryImports.push(path.relative(sourceRoot, file));
  }
}

if (unnecessaryImports.length > 0) {
  throw new Error(
    `Import test APIs from vitest when no database fixture is used:\n${unnecessaryImports.join("\n")}`,
  );
}

function* testFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* testFiles(entryPath);
    } else if (entry.name.endsWith(".test.ts")) {
      yield entryPath;
    }
  }
}

function usesFixture(source: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
      found = node.name.elements.some((element) =>
        fixtureNames.has(
          (element.propertyName ?? element.name).getText(source),
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
