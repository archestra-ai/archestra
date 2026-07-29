/**
 * White-labeling regression guard.
 *
 * A deployment can rebrand the platform by setting `organization.appName`, and
 * user- and LLM-facing copy is expected to resolve that name at runtime —
 * `useAppName()` on the frontend, `archestraMcpBranding.appName` on the backend.
 * Every time the literal brand is typed into a string instead, a white-labeled
 * deployment leaks the vendor's name to its own users.
 *
 * This script fails when the capitalized brand appears in text that ships:
 * string literals, template literals, and JSX text. Comments, identifiers
 * (`ArchestraContext`), lowercase occurrences (`archestra__` tool prefixes,
 * `@archestra/shared` imports, `archestra.ai` URLs), and SCREAMING_CASE
 * occurrences (`ARCHESTRA_*` env vars) are all left alone — they are stable
 * contracts, not copy. Hyphen-joined occurrences (`X-Archestra-User-Id`) are
 * skipped for the same reason: those are wire header names.
 *
 * Usage:
 *   tsx standalone-scripts/check-white-label-copy.ts
 *
 * Two escape hatches, in order of preference:
 *
 *   1. Per-occurrence — put `white-label-ok: <reason>` in a comment on the
 *      offending line or the line above it. A reason is required. Use this when
 *      one string in an otherwise brand-neutral file genuinely names the vendor
 *      (e.g. the `archestra` LLM provider, which names the upstream product you
 *      are connecting to, not this deployment).
 *
 *   2. Per-file — add the path to ALLOWLISTED_FILES below, with a reason. Use
 *      this only for files that are entirely about the default brand.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** The capitalized brand. Lowercase/SCREAMING_CASE variants are contracts, not copy. */
const BRAND = "Archestra";

/** Comment marker that waives a single occurrence; must be followed by a reason. */
const SUPPRESSION = "white-label-ok:";

const SCAN_ROOTS = ["frontend/src", "backend/src", "shared"] as const;

/**
 * Files that are legitimately about the default brand in their entirety. Each
 * entry needs a reason — if you cannot write one, the file probably has a real
 * leak in it.
 */
const ALLOWLISTED_FILES: Record<string, string> = {
  // Defines the default brand itself, plus header names, token prefixes and
  // on-disk paths that are stable contracts.
  "shared/consts.ts": "defines the default brand and the wire/path contracts",
  // MCP wire protocol: server name, tool prefix, catalog id, and the
  // branding-aware helpers that derive white-labeled names from them.
  "shared/archestra-mcp-server.ts": "MCP wire names and the branding helpers",
  // Shipped built-in skill text. Rebranded at reconcile time by
  // `applyBuiltInSkillBranding`, so the literals here are the source strings
  // that swap is applied to.
  "backend/src/skills/built-in-skills.ts":
    "shipped skill text, rebranded at reconcile by applyBuiltInSkillBranding",
  // Resolves the default brand; the literal is the fallback value.
  "backend/src/archestra-mcp-server/branding.ts":
    "implements the branding resolution itself",
  "frontend/src/lib/hooks/use-app-name.ts":
    "implements the branding resolution itself",
};

/**
 * Directory prefixes exempt in full, same rules as {@link ALLOWLISTED_FILES}.
 */
const ALLOWLISTED_DIRS: Record<string, string> = {
  // Dev tooling that generates Archestra's own published documentation. Its
  // output is vendor docs, not deployment copy.
  "backend/src/standalone-scripts/": "generates Archestra's own docs/tooling",
  // The in-product session recorder exists to submit demos to the Archestra
  // Apps Hackathon — it names the real event and the real GitHub repo, and is
  // hidden entirely unless that offer is enabled.
  "frontend/src/components/app-session-recording/":
    "submits to the real Archestra hackathon repo; gated behind the offer",
};

type Violation = {
  file: string;
  line: number;
  column: number;
  text: string;
};

function main(): void {
  const repoRoot = process.cwd();

  const violations: Violation[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(repoRoot, root))) {
      const rel = relative(repoRoot, file).split(sep).join("/");
      if (ALLOWLISTED_FILES[rel]) continue;
      if (Object.keys(ALLOWLISTED_DIRS).some((dir) => rel.startsWith(dir)))
        continue;
      violations.push(...checkFile(file, rel));
    }
  }

  if (violations.length === 0) {
    console.log(
      `✓ No hardcoded "${BRAND}" in shipped copy across ${SCAN_ROOTS.join(", ")}.`,
    );
    return;
  }

  console.error(
    `\n✗ ${violations.length} hardcoded "${BRAND}" literal(s) in shipped copy.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.column}`);
    console.error(`    ${v.text}`);
  }
  console.error(
    `\nUser-facing copy must resolve the deployment's app name at runtime:` +
      `\n  frontend  useAppName() from @/lib/hooks/use-app-name` +
      `\n  backend   archestraMcpBranding.appName` +
      `\n\nIf an occurrence genuinely names the vendor rather than this deployment` +
      `\n(the upstream product an integration connects to, a wire identifier, or` +
      `\ntext branded downstream by brandBuiltInText), waive it with a comment on` +
      `\nthat line, or in the comment block above it:` +
      `\n  // ${SUPPRESSION} <reason>\n`,
  );
  process.exitCode = 1;
}

/** Every .ts/.tsx file under `dir`, excluding tests, mocks, and generated code. */
function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (
        entry === "node_modules" ||
        entry === "__mocks__" ||
        entry === "mocks"
      )
        continue;
      files.push(...walk(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    // Tests and generated clients assert on or mirror the default brand.
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    if (/\.gen\.ts$/.test(entry)) continue;
    files.push(full);
  }
  return files;
}

function checkFile(absPath: string, relPath: string): Violation[] {
  const source = readFileSync(absPath, "utf8");
  // Cheap bail-out: most files never mention the brand at all.
  if (!source.includes(BRAND)) return [];

  const sourceFile = ts.createSourceFile(
    relPath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = source.split("\n");
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (isShippedText(node) && !isDiagnosticOutput(node)) {
      const text = node.getText(sourceFile);
      if (containsBrandAsCopy(text)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        if (!isSuppressed(lines, line)) {
          violations.push({
            file: relPath,
            line: line + 1,
            column: character + 1,
            text: condense(lines[line] ?? text),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return violations;
}

/** String/template/JSX-text nodes — the kinds whose contents reach a user or a model. */
function isShippedText(node: ts.Node): boolean {
  if (ts.isStringLiteral(node)) {
    // Module specifiers and JSX attribute *names* are wiring, not copy.
    const parent = node.parent;
    if (
      parent &&
      (ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        ts.isModuleDeclaration(parent))
    ) {
      return false;
    }
    return true;
  }
  return (
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isJsxText(node)
  );
}

/**
 * True when the text is (somewhere up the tree) an argument to a logger or
 * console call. Log lines are read by operators looking at this platform's own
 * logs, never by an end user, so naming the vendor there is correct — and
 * rewriting them would make logs harder to search across deployments.
 */
function isDiagnosticOutput(node: ts.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!ts.isCallExpression(cur)) continue;
    const callee = cur.expression;
    if (!ts.isPropertyAccessExpression(callee)) continue;
    const receiver = callee.expression;
    if (!ts.isIdentifier(receiver)) continue;
    if (receiver.text === "logger" || receiver.text === "console") return true;
  }
  return false;
}

/**
 * True when the text uses the brand as prose rather than as part of a
 * hyphen-joined wire identifier (`X-Archestra-Session-Id`, `archestra-limit-*`).
 */
function containsBrandAsCopy(text: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(BRAND, from);
    if (at === -1) return false;
    const before = text[at - 1];
    const after = text[at + BRAND.length];
    const hyphenJoined = before === "-" || after === "-";
    if (!hyphenJoined) return true;
    from = at + BRAND.length;
  }
}

/**
 * A `white-label-ok: <reason>` comment waives the occurrence. It may sit on the
 * offending line, or anywhere in the contiguous comment block directly above it
 * — so a multi-line explanation works and the marker does not have to be on the
 * last line.
 */
function isSuppressed(lines: string[], lineIndex: number): boolean {
  if (hasReasonedMarker(lines[lineIndex])) return true;
  // The line directly above always counts, however it is shaped — the formatter
  // is free to leave a trailing comment on a line that does not *start* like
  // one (e.g. `: // white-label-ok: …` in a wrapped ternary).
  if (hasReasonedMarker(lines[lineIndex - 1])) return true;
  for (let i = lineIndex - 2; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    const isComment =
      line.startsWith("//") ||
      line.startsWith("*") ||
      line.startsWith("/*") ||
      line.startsWith("{/*");
    if (!isComment) return false;
    if (hasReasonedMarker(lines[i])) return true;
  }
  return false;
}

/** True for a marker that actually carries a reason; a bare marker does not count. */
function hasReasonedMarker(line: string | undefined): boolean {
  if (!line) return false;
  const at = line.indexOf(SUPPRESSION);
  if (at === -1) return false;
  return (
    line
      .slice(at + SUPPRESSION.length)
      .replace(/\*\/|\}$/g, "")
      .trim().length > 0
  );
}

function condense(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
}

main();
