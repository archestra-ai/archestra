import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import logger from "@/logging";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OPENAPPA_RS_MANIFEST = path.resolve(
  __dirname,
  "../../../archestra-rs/openappa-rs/Cargo.toml",
);
const SKILLS_DIR = path.resolve(__dirname, "../skills");
const RUNTIME_PACKAGE = "appa";
// OpenAPPA sources copied byte for byte; OpenAPPA's Archestra updater carries
// the same pairs into its pin bumps.
const UPSTREAM_COPIES = [
  {
    source: "integrations/appa-guide/references/core.md",
    output: "appa-guide.core.generated.md",
  },
  {
    source: "website/content/docs/contracts.md",
    output: "appa-guide.contracts.generated.md",
  },
] as const;

const CargoMetadataSchema = z.object({
  packages: z.array(
    z.object({
      name: z.string(),
      source: z.string().nullable(),
      manifest_path: z.string(),
    }),
  ),
});

type PinnedRuntime = { rev: string; checkoutRoot: string };

function findPinnedRuntime(): PinnedRuntime {
  const metadata = CargoMetadataSchema.parse(
    JSON.parse(
      execFileSync(
        "cargo",
        [
          "metadata",
          "--format-version",
          "1",
          "--locked",
          "--manifest-path",
          OPENAPPA_RS_MANIFEST,
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      ),
    ),
  );
  const [runtime, ...others] = metadata.packages.filter(
    (pkg) => pkg.name === RUNTIME_PACKAGE,
  );
  if (!runtime || others.length > 0) {
    throw new Error(
      `Expected exactly one "${RUNTIME_PACKAGE}" package in ${OPENAPPA_RS_MANIFEST}`,
    );
  }
  // A git source reads `git+<url>?rev=<pin>#<resolved commit>`.
  const rev = runtime.source?.match(/^git\+.*#([0-9a-f]{40})$/)?.[1];
  if (!rev) {
    throw new Error(
      `"${RUNTIME_PACKAGE}" is not pinned to a git commit: ${runtime.source}`,
    );
  }
  return {
    rev,
    checkoutRoot: path.dirname(path.dirname(runtime.manifest_path)),
  };
}

function main() {
  const { rev, checkoutRoot } = findPinnedRuntime();
  for (const { source, output } of UPSTREAM_COPIES) {
    const sourcePath = path.join(checkoutRoot, source);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`OpenAPPA ${rev} has no ${source} at ${sourcePath}`);
    }
    const outputPath = path.join(SKILLS_DIR, output);
    fs.copyFileSync(sourcePath, outputPath);
    logger.info(`${source} from OpenAPPA ${rev} copied to ${outputPath}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    logger.error({ error }, "Failed to copy the APPA guide sources");
    process.exit(1);
  }
}
