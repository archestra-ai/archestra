/** Keep the database-free test project free of runtime database imports. */
const forbiddenRuntimeModules =
  "^src/(database/|models/|server\\.ts$|test/(index|fixtures|setup|global-setup|route-test-app)\\.ts$)";

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
  ],
  options: {
    includeOnly: "^src/",
    doNotFollow: { path: forbiddenRuntimeModules },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: false,
    skipAnalysisNotInRules: true,
  },
};
