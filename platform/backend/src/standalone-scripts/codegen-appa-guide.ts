import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import logger from "@/logging";
import {
  APPA_CONTRACTS_PARTS,
  type AppaContractsPartSlug,
  appaContractsPartFile,
  appaContractsPartPath,
} from "@/skills/appa-guide-contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OPENAPPA_RS_MANIFEST = path.resolve(
  __dirname,
  "../../../archestra-rs/openappa-rs/Cargo.toml",
);
const SKILLS_DIR = path.resolve(__dirname, "../skills");
const RUNTIME_PACKAGE = "appa";
// OpenAPPA sources copied byte for byte; OpenAPPA's Archestra updater carries
// the same pairs into its pin bumps. The contracts copy is then split into
// the parts the skill serves.
const CONTRACTS_COPY = "appa-guide.contracts.generated.md";
const UPSTREAM_COPIES = [
  {
    source: "integrations/appa-guide/references/core.md",
    output: "appa-guide.core.generated.md",
  },
  {
    source: "website/content/docs/contracts.md",
    output: CONTRACTS_COPY,
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
  const copies = UPSTREAM_COPIES.map(({ source, output }) => {
    const sourcePath = path.join(checkoutRoot, source);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`OpenAPPA ${rev} has no ${source} at ${sourcePath}`);
    }
    return { source, output, content: fs.readFileSync(sourcePath, "utf8") };
  });
  const contracts = copies.find(({ output }) => output === CONTRACTS_COPY);
  if (!contracts) throw new Error(`${CONTRACTS_COPY} is not copied`);
  const parts = splitContracts(contracts.content);
  for (const { source, output, content } of copies) {
    fs.writeFileSync(path.join(SKILLS_DIR, output), content);
    logger.info(`${source} from OpenAPPA ${rev} copied to ${output}`);
  }
  const partFiles = new Set<string>();
  for (const [slug, content] of parts) {
    partFiles.add(appaContractsPartFile(slug));
    fs.writeFileSync(
      path.join(SKILLS_DIR, appaContractsPartFile(slug)),
      content,
    );
  }
  for (const name of fs.readdirSync(SKILLS_DIR)) {
    if (CONTRACTS_PART_FILE.test(name) && !partFiles.has(name)) {
      fs.rmSync(path.join(SKILLS_DIR, name));
    }
  }
  logger.info(`${CONTRACTS_COPY} split into ${parts.size} parts`);
}

type Heading = { line: string; offset: number };

/**
 * Splits the policy reference at the headings of APPA_CONTRACTS_PARTS. The
 * website frontmatter and intro before the first one are dropped, links into
 * another part name that part's path, and site-relative links become text.
 */
function splitContracts(upstream: string): Map<AppaContractsPartSlug, string> {
  const headings = scanHeadings(upstream);
  const owners = new Map<string, AppaContractsPartSlug>(
    APPA_CONTRACTS_PARTS.flatMap(({ slug, headings }) =>
      headings.map((heading) => [heading, slug] as const),
    ),
  );
  const seen = new Set<string>();
  const starts: { slug: AppaContractsPartSlug; offset: number }[] = [];
  for (const { line, offset } of headings) {
    const slug = owners.get(line);
    if (slug === undefined) {
      if (line.startsWith("## ")) {
        throw new Error(`Upstream heading "${line}" belongs to no part`);
      }
      continue;
    }
    if (seen.has(line)) {
      throw new Error(`Upstream heading "${line}" appears twice`);
    }
    seen.add(line);
    starts.push({ slug, offset });
  }
  const missing = [...owners.keys()].filter((heading) => !seen.has(heading));
  if (missing.length > 0) {
    throw new Error(`Upstream has no heading ${missing.join(", ")}`);
  }
  const chunks = starts.map(({ slug, offset }, index) => ({
    slug,
    offset,
    end: starts[index + 1]?.offset ?? upstream.length,
  }));
  // null marks an anchor more than one heading produces.
  const anchors = new Map<string, AppaContractsPartSlug | null>();
  for (const { line, offset } of headings) {
    const chunk = chunks.find((c) => c.offset <= offset && offset < c.end);
    if (!chunk) continue;
    const anchor = headingAnchor(line);
    anchors.set(anchor, anchors.has(anchor) ? null : chunk.slug);
  }
  const parts = new Map<AppaContractsPartSlug, string>(
    APPA_CONTRACTS_PARTS.map(({ slug }) => [slug, ""]),
  );
  for (const { slug, offset, end } of chunks) {
    const text = rewriteLinks({
      text: upstream.slice(offset, end),
      slug,
      anchors,
    });
    parts.set(slug, (parts.get(slug) ?? "") + text);
  }
  return parts;
}

function rewriteLinks(params: {
  text: string;
  slug: AppaContractsPartSlug;
  anchors: Map<string, AppaContractsPartSlug | null>;
}): string {
  let fenced = false;
  return params.text
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) fenced = !fenced;
      if (fenced) return line;
      return line
        .replace(/\[([^\]]+)\]\(\/[^)]*\)/g, "$1")
        .replace(/\]\(#([^)]+)\)/g, (link, anchor: string) => {
          const target = params.anchors.get(anchor);
          if (!target) {
            throw new Error(`Link to #${anchor} has no single target heading`);
          }
          return target === params.slug
            ? link
            : `](${appaContractsPartPath(target)}#${anchor})`;
        });
    })
    .join("\n");
}

function scanHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  let fenced = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (!fenced && /^#{1,6} /.test(line)) headings.push({ line, offset });
    offset += line.length + 1;
  }
  return headings;
}

// GitHub-style anchor: lowercase, punctuation dropped, spaces to dashes.
function headingAnchor(heading: string): string {
  return heading
    .replace(/^#+ /, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const CONTRACTS_PART_FILE = /^appa-guide\.contracts\.[\w-]+\.generated\.md$/;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    logger.error({ error }, "Failed to copy the APPA guide sources");
    process.exit(1);
  }
}
