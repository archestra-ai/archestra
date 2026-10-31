import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";
import {
  detectResourceEnvelope,
  frontendVitestResourceLimits,
} from "../vitest.resources";
import { vitestLogPolicy } from "../vitest.shared";

const isCI = process.env.CI === "true";
const testFiles = partitionTestFiles();
// Half the cores locally, as before. CI runs on a dedicated high-RAM runner
// where the uncapped default is fine, so there it keeps the 8 GiB heap
// ceiling and Vitest's own worker count; a container with a memory limit is
// sized for the container either way. Override on a big local machine with
// `--maxWorkers=<n|%>`.
const envelope = detectResourceEnvelope();
const { maxWorkers, maxOldSpaceMb } =
  isCI && !envelope.constrained
    ? { maxWorkers: undefined, maxOldSpaceMb: 8192 }
    : frontendVitestResourceLimits(envelope);

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
      "@archestra/shared/built-in-agents": path.resolve(
        __dirname,
        "../shared/built-in-agents.ts",
      ),
      "@archestra/shared/consts": path.resolve(
        __dirname,
        "../shared/consts.ts",
      ),
      "@archestra/shared/connection-setup": path.resolve(
        __dirname,
        "../shared/connection-setup.ts",
      ),
      "@archestra/shared/interactions/client": path.resolve(
        __dirname,
        "../shared/interactions/client.ts",
      ),
      "@archestra/shared/model-price": path.resolve(
        __dirname,
        "../shared/model-price.ts",
      ),
      "@archestra/shared/version": path.resolve(
        __dirname,
        "../shared/version.ts",
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
    // JSDOM-heavy frontend tests need a larger worker heap on Node 24; inside
    // a container the heap ceiling is each fork's share of the container's
    // memory, because the kernel kills the container before V8 would give up.
    pool: "forks",
    execArgv: [`--max-old-space-size=${maxOldSpaceMb}`],
    // Each fork is a separate process, so worker count multiplies memory. The
    // cap keeps this suite from exhausting RAM when it runs alongside the
    // shared/type-check/lint tasks under `turbo test`, and from passing the
    // limit of an Agent Runtime pod.
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
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
