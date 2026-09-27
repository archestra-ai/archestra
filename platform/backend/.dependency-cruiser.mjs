/** Keep the database-free test project free of runtime database imports. */
const forbiddenRuntimeModules =
  "^src/(config\\.ts$|database/|models/|server\\.ts$|test/(index|fixtures|setup|global-setup|route-test-app)\\.ts$)";

export default {
  forbidden: [
    {
      name: "unit-tests-do-not-load-database",
      severity: "error",
      comment:
        "*.unit.test.ts files run without PGlite. Move database-backed tests to *.test.ts, or remove the runtime import chain.",
      from: { path: "^src/.*\\.unit\\.test\\.ts$" },
      to: {
        path: forbiddenRuntimeModules,
        reachable: true,
      },
    },
    {
      name: "plugin-imports-do-not-load-database",
      severity: "error",
      comment:
        "GitHub plugin import helpers must stay outside the database and server import graph so their tests remain cheap to load.",
      from: {
        path: "^src/plugins/(github-import|github-tree|plugin-tree-files)\\.ts$",
      },
      to: {
        path: forbiddenRuntimeModules,
        reachable: true,
      },
    },
  ],
  options: {
    includeOnly: "^src/",
    doNotFollow: { path: forbiddenRuntimeModules },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: false,
    skipAnalysisNotInRules: true,
  },
};
