// biome-ignore-all lint/suspicious/noConsole: administrator CLI prints reports to the terminal
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { initializeDatabase } from "@/database";
import { compareRuns } from "@/knowledge-base/evaluation/compare";
import {
  assertGoldenMatchesCorpus,
  DEFAULT_CORPUS_PATH,
  DEFAULT_GOLDEN_PATH,
  digestFile,
  FixtureError,
  loadCorpus,
  loadGolden,
} from "@/knowledge-base/evaluation/fixtures";
import {
  renderComparison,
  renderRun,
} from "@/knowledge-base/evaluation/report";
import { runInstance } from "@/knowledge-base/evaluation/run";
import {
  type RunArtifact,
  RunArtifactSchema,
} from "@/knowledge-base/evaluation/schema";
import OrganizationModel from "@/models/organization";

/**
 * Run inside an Archestra platform container. The process inherits the pod's
 * real database, secrets-manager, provider endpoints and deployment settings.
 * It never accepts model credentials or retrieval-setting overrides.
 */

const USAGE = `usage:
  kb-retrieval-eval run --organization-id <uuid|auto> [--name <label>] [--limit <k>] [--out <file>] [--keep-fixture] [--corpus <file>] [--golden <file>]
  kb-retrieval-eval diff <before.json> <after.json> [--all]

Production pod example:
  kubectl exec -n <namespace> deploy/<archestra-platform> -- \\
    node /app/backend/dist/standalone-scripts/kb-retrieval-eval.mjs run --organization-id <uuid>

"auto" is intended for the single-organization Tilt development database.`;

const EXIT_DEGRADED = 1;
const EXIT_USAGE = 2;

class UsageError extends Error {}

function readArtifact(filePath: string): RunArtifact {
  const parsed = RunArtifactSchema.safeParse(
    JSON.parse(fs.readFileSync(filePath, "utf8")),
  );
  if (!parsed.success) {
    throw new FixtureError(
      `${filePath}: not a current run artifact: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : EXIT_USAGE;
  }

  if (command === "diff") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { all: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    if (positionals.length !== 2) {
      throw new UsageError("diff needs two artifact paths");
    }
    console.log(
      renderComparison(
        compareRuns(readArtifact(positionals[0]), readArtifact(positionals[1])),
        { all: values.all },
      ),
    );
    return 0;
  }

  if (command !== "run") {
    throw new UsageError(`unknown command: ${command}`);
  }
  await initializeDatabase();
  const { values } = parseArgs({
    args: rest,
    options: {
      "organization-id": { type: "string" },
      name: { type: "string" },
      limit: { type: "string", default: "10" },
      out: { type: "string" },
      "keep-fixture": { type: "boolean", default: false },
      corpus: { type: "string", default: DEFAULT_CORPUS_PATH },
      golden: { type: "string", default: DEFAULT_GOLDEN_PATH },
    },
  });
  if (!values["organization-id"]) {
    throw new UsageError("run needs --organization-id <uuid|auto>");
  }
  const queryLimit = Number(values.limit);
  if (!Number.isInteger(queryLimit) || queryLimit < 1 || queryLimit > 100) {
    throw new UsageError("--limit must be an integer between 1 and 100");
  }
  const organizationId = await resolveOrganizationId(values["organization-id"]);
  const corpus = loadCorpus(values.corpus);
  const golden = loadGolden(values.golden);
  assertGoldenMatchesCorpus(golden, corpus);
  const artifact = await runInstance({
    organizationId,
    name: values.name,
    queryLimit,
    keepFixture: values["keep-fixture"],
    corpus,
    golden,
    corpusDigest: digestFile(values.corpus),
    goldenDigest: digestFile(values.golden),
  });
  const outFile =
    values.out ??
    path.join(
      os.tmpdir(),
      `kb-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(renderRun(artifact));
  console.log(`\nartifact: ${outFile}`);
  if (artifact.status === "blocked") return EXIT_USAGE;
  if (artifact.status === "degraded") return EXIT_DEGRADED;
  return 0;
}

async function resolveOrganizationId(value: string): Promise<string> {
  if (value !== "auto") return value;
  const organization = await OrganizationModel.getFirst();
  if (!organization) {
    throw new UsageError("--organization-id auto found no organization");
  }
  console.error(
    `note: --organization-id auto selected ${organization.id}; pass an explicit UUID outside a single-organization development stack`,
  );
  return organization.id;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof UsageError) {
        console.error(`error: ${error.message}\n\n${USAGE}`);
      } else {
        console.error(
          `error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      process.exit(EXIT_USAGE);
    });
}
