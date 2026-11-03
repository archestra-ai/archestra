/**
 * Workspace checks, one child at a time. Keeping eight pnpm processes and a
 * concurrent task runner resident costs a small runtime memory even while the
 * heavy-command lane makes their tools wait. This runner starts each tool
 * directly, releases its memory, and stops on the first failure.
 *
 * `test` preserves Vitest's CLI arguments, including watch mode. `ci` runs the
 * finite test suite after static checks; `commit` omits tests.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectResourceEnvelope,
  heavyLaneActive,
} from "../vitest.resources.ts";
import { runWorkspaceChecks, type WorkspaceCheck } from "./check-sequence.ts";

const SCRIPT = fileURLToPath(import.meta.url);
export function runWorkspaceCommand(input: string[]): number {
  const [mode, ...args] = input;
  const workspace = path.basename(process.cwd());
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const rootTasks: Record<string, string> = {
    "all-commit": "check:commit",
    "all-ci": "check:ci",
    "all-type-check": "type-check",
    "all-test": "test",
    "all-knip": "knip",
    "all-build": "build",
    "all-lint": "lint",
  };
  const rootTask = rootTasks[mode];
  if (rootTask) {
    if (manifest.name !== "archestra-platform") {
      throw new Error("Run workspace-wide checks from platform/.");
    }
    // Turbo options must precede "--"; everything after it belongs to the
    // workspace tool (for example Vitest's "run"), not Turbo.
    const separator = args.indexOf("--");
    const turboArgs = separator < 0 ? args : args.slice(0, separator);
    const toolArgs = separator < 0 ? [] : args.slice(separator);
    const chosenConcurrency = turboArgs.some(
      (arg) => arg === "--concurrency" || arg.startsWith("--concurrency="),
    );
    return runWorkspaceChecks([
      {
        label: "workspace checks",
        command: "turbo",
        args: [
          rootTask,
          ...turboArgs,
          // Each workspace has a resident runner too. In a small runtime
          // only one workspace starts tools; its heavy tools own the lane.
          ...(heavyLaneActive(detectResourceEnvelope()) && !chosenConcurrency
            ? ["--concurrency=1"]
            : []),
          ...toolArgs,
        ],
        managesLane: mode !== "all-build",
        ...(mode === "all-build" ? { peakBytes: 3 * 1024 ** 3 } : {}),
      },
    ]);
  }
  if (workspace === "frontend" && mode === "build") {
    if (manifest.name !== "@frontend") {
      throw new Error(`Unexpected workspace: ${manifest.name}`);
    }
    const envelope = detectResourceEnvelope();
    const constrained = heavyLaneActive(envelope);
    const explicitBundler = args.some((arg) =>
      ["--webpack", "--turbo", "--turbopack"].includes(arg),
    );
    const nodeOptions = process.env.NODE_OPTIONS ?? "";
    const buildArgs = [...(!explicitBundler ? ["--turbopack"] : []), ...args];
    return runWorkspaceChecks([
      {
        label: "frontend build",
        command: constrained ? "bash" : "next",
        args: constrained
          ? [
              path.join(path.dirname(SCRIPT), "dev-lite.sh"),
              "frontend-artifact",
              "build",
              ...buildArgs,
            ]
          : ["build", ...buildArgs],
        peakBytes: 3.7 * 1024 ** 3,
        env: constrained
          ? {
              ...process.env,
              ARCHESTRA_DEV_LITE_SOURCE_MAPS:
                process.env.ARCHESTRA_DEV_LITE_SOURCE_MAPS ?? "false",
              CIRCLE_NODE_TOTAL:
                process.env.CIRCLE_NODE_TOTAL ??
                String(envelope.availableParallelism + 1),
              NODE_OPTIONS: /--max[-_]old[-_]space[-_]size(?:=|\s)/.test(
                nodeOptions,
              )
                ? nodeOptions
                : `${nodeOptions} --max-old-space-size=2048`.trim(),
            }
          : process.env,
      },
    ]);
  }
  if (
    !["backend", "frontend", "shared", "e2e-tests"].includes(workspace) ||
    !["commit", "ci", "test"].includes(mode) ||
    (mode !== "test" && args.length > 0) ||
    (mode === "test" && workspace === "e2e-tests")
  ) {
    throw new Error(
      "Run from backend, frontend, shared, or e2e-tests: check-workspace.ts commit|ci|test [Vitest arguments]",
    );
  }
  // Fail before spawning anything when this is not a workspace checkout.
  const names: Record<string, string> = {
    backend: "@backend",
    frontend: "@frontend",
    shared: "@archestra/shared",
    "e2e-tests": "@e2e-tests",
  };
  if (manifest.name !== names[workspace]) {
    throw new Error(`Unexpected workspace: ${manifest.name}`);
  }
  return runWorkspaceChecks(
    mode === "test"
      ? [vitestCheck(workspace, args)]
      : staticChecks(workspace, mode === "ci"),
  );
}

// ===== Internal helpers =====

function nodeCheck(
  workspace: string,
  label: string,
  script: string,
  args: string[] = [],
  options: { standalone?: boolean; native?: boolean } = {},
): WorkspaceCheck {
  return {
    label: `${label} (${workspace})`,
    command: process.execPath,
    args: [
      ...(options.native && process.features.typescript
        ? ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"]
        : ["--import", "tsx"]),
      script,
      ...args,
    ],
    ...(options.standalone
      ? {
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: "standalone-scripts.tsconfig.json",
          },
        }
      : {}),
  };
}

function vitestCheck(workspace: string, args: string[]): WorkspaceCheck {
  return {
    label: `tests (${workspace})`,
    command: "vitest",
    args,
    // The runner, one sized worker and its native/DOM state. Small runtimes
    // pause the servers while these run, and serialize tests with compilers.
    peakBytes: (workspace === "shared" ? 1.0 : 2.6) * 1024 ** 3,
  };
}

function staticChecks(workspace: string, tests: boolean): WorkspaceCheck[] {
  // Both Turbo check tasks run this sequence. Keep check:ci/check:commit
  // inputs in platform/turbo.json in sync when adding helper dependencies.
  // Turbo schedules shared's type-check as a prerequisite. Direct package
  // commands still run it here, since they have no task graph.
  const checks: WorkspaceCheck[] = [
    ...(workspace === "shared" && process.env.TURBO_HASH
      ? []
      : [
          {
            ...nodeCheck(
              workspace,
              "type-check",
              path.join(path.dirname(SCRIPT), "type-check.ts"),
              ["--noEmit"],
              { native: true },
            ),
            managesLane: true,
          },
        ]),
    { label: `knip (${workspace})`, command: "knip", args: [] },
    ...(workspace === "backend"
      ? [
          {
            label: "knip --production (backend)",
            command: "knip",
            args: ["--production"],
          },
        ]
      : []),
    { label: `biome (${workspace})`, command: "biome", args: ["ci"] },
  ];
  if (workspace === "backend") {
    checks.push(
      {
        label: "declaration cache (backend)",
        command: process.execPath,
        args: ["--test", "../scripts/backend-types-prebuilt.test.mjs"],
      },
      nodeCheck(
        workspace,
        "migration journal",
        "src/standalone-scripts/check-drizzle-migration-journal.ts",
        [],
        { standalone: true },
      ),
      nodeCheck(
        workspace,
        "migration lint",
        "src/standalone-scripts/lint-drizzle-migrations.ts",
        [],
        { standalone: true },
      ),
      nodeCheck(
        workspace,
        "sandbox base",
        "src/standalone-scripts/check-sandbox-base-sync.ts",
        [],
        { standalone: true },
      ),
      {
        label: "test import boundaries (backend)",
        command: "dependency-cruiser",
        args: [
          "--config",
          ".dependency-cruiser.mjs",
          "src/**/*.unit.test.ts",
          "src/plugins/github-import.ts",
          "src/plugins/github-tree.ts",
          "src/plugins/plugin-tree-files.ts",
          "--output-type",
          "err",
        ],
      },
      nodeCheck(
        workspace,
        "test fixture imports",
        "src/standalone-scripts/check-test-fixture-imports.ts",
        [],
        { standalone: true },
      ),
      {
        label: "layer order (backend)",
        command: process.execPath,
        args: ["scripts/check-layers.mjs"],
      },
      {
        label: "project ownership (backend)",
        command: process.execPath,
        args: [
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          "scripts/check-projects.mjs",
        ],
      },
    );
  }
  // e2e-tests checks static inputs here; browser execution has its own lane.
  if (tests && workspace !== "e2e-tests") {
    checks.push(vitestCheck(workspace, ["run"]));
  }
  return checks;
}
