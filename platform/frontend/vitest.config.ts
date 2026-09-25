import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";
import { vitestLogPolicy } from "../vitest.shared";

const isCI = process.env.CI === "true";
const testFiles = partitionTestFiles();

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // Explicit absolute-path alias (tsconfigPaths also provides "@/", but
      // Vitest's Jest-style __mocks__ sibling resolution only works reliably
      // through resolve.alias — with tsconfig-paths-only aliasing it silently
      // falls back to automocking (vitest-dev/vitest#8343).
      "@": path.resolve(__dirname, "./src"),
      "@archestra/shared/access-control": path.resolve(
        __dirname,
        "../shared/access-control.ts",
      ),
      "@archestra/shared/api-error": path.resolve(
        __dirname,
        "../shared/api-error.ts",
      ),
      "@archestra/shared/consts": path.resolve(
        __dirname,
        "../shared/consts.ts",
      ),
      "@archestra/shared": path.resolve(__dirname, "../shared/index.ts"),
    },
  },
  test: {
    ...vitestLogPolicy,
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest-setup.ts"],
    testTimeout: 10_000,
    // JSDOM-heavy frontend tests need a larger worker heap on Node 24.
    pool: "forks",
    execArgv: ["--max-old-space-size=8192"],
    // Each fork is a separate process, so worker count multiplies memory. Cap
    // to half the cores locally so this suite doesn't exhaust RAM when it runs
    // alongside the shared/type-check/lint tasks under `turbo test`. CI runs on
    // a dedicated high-RAM runner where the uncapped default is fine, so it's
    // left alone. Override on a big local machine with `--maxWorkers=<n|%>`.
    ...(isCI ? {} : { maxWorkers: "50%" }),
    // Caps concurrent `test.concurrent` cases within a single file (plain
    // sequential test() is unaffected). Kept as a low guardrail so a future
    // concurrent suite can't pile jsdom work into one worker; worker count is
    // capped separately by maxWorkers above.
    maxConcurrency: 2,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: testFiles.node,
          environment: "node",
          setupFiles: [],
          isolate: false,
          unstubGlobals: true,
          unstubEnvs: true,
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          include: testFiles.jsdom,
        },
      },
    ],
  },
});

function partitionTestFiles(): { node: string[]; jsdom: string[] } {
  const node: string[] = [];
  const jsdom: string[] = [];
  const root = path.resolve(__dirname, "src");

  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/\.test\.tsx?$/.test(entry.name)) continue;

    const absolute = path.join(entry.parentPath, entry.name);
    const relative = `./${path.relative(__dirname, absolute)}`;
    const source = readFileSync(absolute, "utf8");
    if (source.startsWith("// @vitest-environment node")) {
      if (/\bvi\.(mock|doMock|unmock|doUnmock|hoisted)\s*\(/.test(source)) {
        throw new Error(
          `${relative} cannot use module mocks in the shared-worker Node project`,
        );
      }
      node.push(relative);
    } else {
      jsdom.push(relative);
    }
  }

  return { node, jsdom };
}
