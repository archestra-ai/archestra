"use client";

import { ArrowUpRight, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  TRUNCATED_CONTENT_MAX_LINES,
  TruncatedContent,
} from "@/components/ai-elements/truncated-content";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { cn } from "@/lib/utils/tailwind";
import { getPolicyDiffRows, type PolicyDiffRow } from "./policy-diff-rows";

type PolicyChange = {
  stage?: "preview";
  delivery: "revision" | "pull_request";
  before: string;
  after: string;
  /** The backend's unified diff, trimmed to the changed hunks. */
  diff?: string;
  path?: string;
  revision?: number;
  number?: number;
  url?: string;
  warnings?: string[];
  errors?: string[];
  enforcement?: { enabled: boolean; reason?: string };
  effective?: { error: string | null; batteries: { status: string }[] };
};

export function OpenAppaPolicyChange({
  output,
  validationChange = false,
}: {
  output: unknown;
  validationChange?: boolean;
}) {
  const change = parsePolicyChange(output, validationChange);
  if (!change) return null;
  const path = change.path ?? "organization.appa.toml";
  // Previewing the unsaved starter changes no line.
  const unchanged = change.before === change.after;
  const pullUrl =
    change.delivery === "pull_request" ? changeRequestUrl(change.url) : null;
  return (
    <div className="space-y-3 p-3">
      {pullUrl && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" asChild>
            <a href={pullUrl} target="_blank" rel="noreferrer">
              <span>Review {changeRequestNoun(pullUrl)}</span>
              <ArrowUpRight className="size-3.5" />
            </a>
          </Button>
        </div>
      )}
      {/* A validation change can touch any of several files; name it. The
          policy is always the one file, so its name says nothing. */}
      {validationChange && (
        <p className="font-mono text-xs text-muted-foreground">{path}</p>
      )}
      <PolicyDiff
        rows={getPolicyDiffRows({
          before: change.before,
          after: change.after,
          // Previewing the unsaved starter changes no line: every line is new.
          diff: unchanged
            ? null
            : change.diff || policyDiff(change.before, change.after, path),
        })}
      />
      {change.warnings?.map((warning) => (
        <InlineNotice key={warning} variant="warning">
          <TriangleAlert />
          <span className="font-medium">Policy warning</span>
          <InlineNoticeText>{warning}</InlineNoticeText>
        </InlineNotice>
      ))}
      {change.errors?.map((error) => (
        <InlineNotice key={error} variant="error">
          <TriangleAlert />
          <span className="font-medium">Policy error</span>
          <InlineNoticeText>{error}</InlineNoticeText>
        </InlineNotice>
      ))}
    </div>
  );
}

/**
 * The proposed policy as numbered lines: new lines green, removed lines red,
 * unchanged runs folded. Long views cut off like a tool's Input and Output.
 */
function PolicyDiff({ rows }: { rows: PolicyDiffRow[] }) {
  return (
    <TruncatedContent lineCount={rows.length}>
      {(showAll) => (
        <section
          aria-label="Policy diff"
          className="overflow-hidden rounded-md border border-border/50 bg-background py-1 font-mono text-[0.6875rem] leading-4"
        >
          {(showAll ? rows : rows.slice(0, TRUNCATED_CONTENT_MAX_LINES)).map(
            (row, index) => (
              <PolicyDiffLine
                // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered rows
                key={index}
                row={row}
              />
            ),
          )}
        </section>
      )}
    </TruncatedContent>
  );
}

function PolicyDiffLine({ row }: { row: PolicyDiffRow }) {
  if (row.kind === "gap") {
    return (
      <div className="bg-muted/40 pl-11 font-sans leading-5 text-muted-foreground">
        <span aria-hidden>···</span>
        <span className="sr-only">Unchanged lines hidden</span>
      </div>
    );
  }
  return (
    <div
      className={cn(
        // Long lines wrap under their own text instead of scrolling sideways.
        "flex whitespace-pre-wrap [overflow-wrap:anywhere]",
        row.kind === "add" && "bg-emerald-500/10",
        row.kind === "remove" && "bg-destructive/10",
      )}
    >
      <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/70">
        {row.line ?? ""}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 border-l-[3px] border-transparent pl-2",
          row.kind === "add" &&
            "border-emerald-600 text-emerald-800 dark:text-emerald-300",
          row.kind === "remove" &&
            "border-destructive text-destructive line-through decoration-destructive/40",
        )}
      >
        {row.kind === "add" ? (
          <span className="sr-only">Added: </span>
        ) : row.kind === "remove" ? (
          <span className="sr-only">Removed: </span>
        ) : null}
        <span>{row.text || " "}</span>
      </span>
    </div>
  );
}

type SaveResult = {
  tone: "success" | "warning";
  title: string;
  detail: string;
  action: { label: string; href: string; external: boolean };
  /** A local save, so the Git sync tip may apply. */
  local: boolean;
};

/**
 * What a saved policy change reports: an opened pull request, or a saved
 * revision and whether enforcement now uses it. Null for a preview or a
 * result that is neither.
 */
export function getPolicySaveResult(output: unknown): SaveResult | null {
  const change = parsePolicyChange(output);
  const url =
    change?.stage !== "preview" && change?.delivery === "pull_request"
      ? changeRequestUrl(change.url)
      : null;
  if (change && url) {
    return {
      tone: "success",
      title: `Opened ${changeRequestShort(url)} #${change.number}`,
      detail: "merge it to apply",
      action: {
        label: `Review ${changeRequestNoun(url)}`,
        href: url,
        external: true,
      },
      local: false,
    };
  }
  if (
    !change ||
    change.stage === "preview" ||
    change.delivery !== "revision" ||
    !Number.isSafeInteger(change.revision) ||
    (change.revision ?? 0) < 1
  )
    return null;
  const healthy =
    change.effective?.error === null &&
    Array.isArray(change.effective.batteries) &&
    change.effective.batteries.every((battery) => battery.status === "active");
  const active = healthy && change.enforcement?.enabled === true;
  return {
    tone: active ? "success" : "warning",
    title: `Saved revision ${change.revision}`,
    detail: active
      ? "enforcement on"
      : change.effective?.error ||
        change.enforcement?.reason ||
        (change.enforcement?.enabled === false
          ? "enforcement is off"
          : "check composition and enforcement"),
    action: active
      ? { label: "View Guardrails", href: "/openappa", external: false }
      : { label: "Check policy", href: "/openappa/policy", external: false },
    local: true,
  };
}

/**
 * Which save a tool call's result reports, if any: the call that saved the
 * policy, or the one that saved validations, with a readable result.
 */
export function getOpenAppaSaveResult({
  shortName,
  output,
}: {
  shortName: string | null;
  output: unknown;
}): "policy" | "validation" | null {
  if (shortName === "update_guardrails_policy") {
    return getPolicySaveResult(output) ? "policy" : null;
  }
  if (shortName === "update_guardrails_validation") {
    return getValidationSaveResult(output) ? "validation" : null;
  }
  return null;
}

/** The result of a saved policy change, as one line in its tool card. */
export function OpenAppaPolicyCompletion({ output }: { output: unknown }) {
  const result = getPolicySaveResult(output);
  if (!result) return null;
  return (
    <SaveResultLine result={result}>
      {result.local ? <GithubSyncTip /> : null}
    </SaveResultLine>
  );
}

function SaveResultLine({
  result,
  children,
}: {
  result: SaveResult;
  children?: ReactNode;
}) {
  const linkClassName = cn(
    "inline-flex items-center gap-0.5 font-medium underline underline-offset-4",
    result.tone === "success"
      ? "text-emerald-700 dark:text-emerald-400"
      : "text-amber-700 dark:text-amber-400",
  );
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 py-3 text-sm">
      <span
        className={cn(
          "font-medium",
          result.tone === "success"
            ? "text-emerald-700 dark:text-emerald-400"
            : "text-amber-700 dark:text-amber-400",
        )}
      >
        {result.title}
      </span>
      <span className="text-muted-foreground">· {result.detail} ·</span>
      {result.action.external ? (
        <a
          href={result.action.href}
          target="_blank"
          rel="noreferrer"
          className={linkClassName}
        >
          {result.action.label}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </a>
      ) : (
        <Link href={result.action.href} className={linkClassName}>
          {result.action.label}
        </Link>
      )}
      {children}
    </div>
  );
}

/**
 * In a locally saved revision's banner: Git sync is set up in the guardrails
 * settings, opened in a new tab so the chat stays put and the operator sees
 * what setup leaves to do (such as merging its pull request).
 */
function GithubSyncTip() {
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const { data: sync } = useAppaGithubSync();
  if (canManage !== true || !sync?.enabled || sync.source?.repo) return null;
  return (
    // Its own line under the result.
    <p className="basis-full text-xs text-muted-foreground">
      Tip: keep the policy in GitHub or GitLab, so every change gets reviewed.{" "}
      <a
        href="/settings/guardrails?setup=github-sync"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 font-medium underline underline-offset-4"
      >
        <span>Set up Git sync</span>
        <ArrowUpRight className="size-3" aria-hidden />
      </a>
    </p>
  );
}

/**
 * What saved validations report: an opened pull request, or a local save.
 * Saving runs nothing; the agent runs the saved files separately. Null for a
 * preview or an unreadable result.
 */
export function getValidationSaveResult(output: unknown): SaveResult | null {
  const change = parseOutput(output);
  if (!change || change.stage === "preview") return null;
  const pullUrl =
    change.delivery === "pull_request" &&
    Number.isSafeInteger(change.number) &&
    (change.number as number) > 0
      ? changeRequestUrl(change.url)
      : null;
  if (
    !pullUrl &&
    (change.delivery !== "revision" ||
      typeof change.version !== "string" ||
      !change.version)
  )
    return null;
  if (pullUrl) {
    return {
      tone: "success",
      title: `Opened ${changeRequestShort(pullUrl)} #${change.number}`,
      detail: "merge it to apply",
      action: {
        label: `Review ${changeRequestNoun(pullUrl)}`,
        href: pullUrl,
        external: true,
      },
      local: false,
    };
  }
  return {
    tone: "success",
    title:
      change.policyChanged === true
        ? "Saved policy and validations"
        : "Saved validations",
    detail: "not run yet",
    action: {
      label: "View Validations",
      href: "/openappa/validation",
      external: false,
    },
    local: true,
  };
}

/** The result of saved validations, as one line in its tool card. */
export function OpenAppaValidationCompletion({ output }: { output: unknown }) {
  const result = getValidationSaveResult(output);
  return result ? <SaveResultLine result={result} /> : null;
}

export function isOpenAppaPolicyChange(
  output: unknown,
  validationChange = false,
): boolean {
  return parsePolicyChange(output, validationChange) !== null;
}

function parseOutput(output: unknown): Record<string, unknown> | null {
  let candidate = output;
  if (candidate && typeof candidate === "object") {
    if ("isError" in candidate && candidate.isError === true) return null;
    if ("structuredContent" in candidate) {
      candidate = candidate.structuredContent;
    } else if ("content" in candidate) {
      candidate = candidate.content;
    }
  }
  if (Array.isArray(candidate)) {
    candidate = candidate.find(
      (item) => item && typeof item === "object" && item.type === "text",
    )?.text;
  }
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as Record<string, unknown>;
}

function parsePolicyChange(
  output: unknown,
  validationChange = false,
): PolicyChange | null {
  const value = parseOutput(output);
  if (!value) return null;
  // A validation preview never changes the policy, so it has no diff card.
  if (
    validationChange &&
    (value.stage === "preview" || value.before === value.after)
  )
    return null;
  if (
    (value.delivery !== "revision" && value.delivery !== "pull_request") ||
    typeof value.before !== "string" ||
    typeof value.after !== "string"
  )
    return null;
  return value as PolicyChange;
}

function policyDiff(before: string, after: string, path: string): string {
  const oldLines = before.replace(/\n$/, "").split("\n");
  const newLines = after.replace(/\n$/, "").split("\n");
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  if (oldLines.length * newLines.length > 160_000) {
    // Large policies still show an accurate replacement without quadratic work.
    return [
      ...lines,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ].join("\n");
  }
  const width = newLines.length + 1;
  const lengths = new Uint16Array((oldLines.length + 1) * width);
  for (let old = oldLines.length - 1; old >= 0; old--) {
    for (let next = newLines.length - 1; next >= 0; next--) {
      lengths[old * width + next] =
        oldLines[old] === newLines[next]
          ? lengths[(old + 1) * width + next + 1] + 1
          : Math.max(
              lengths[(old + 1) * width + next],
              lengths[old * width + next + 1],
            );
    }
  }
  let old = 0;
  let next = 0;
  while (old < oldLines.length || next < newLines.length) {
    if (
      old < oldLines.length &&
      next < newLines.length &&
      oldLines[old] === newLines[next]
    ) {
      lines.push(` ${oldLines[old]}`);
      old++;
      next++;
    } else if (
      next < newLines.length &&
      (old === oldLines.length ||
        lengths[old * width + next + 1] >= lengths[(old + 1) * width + next])
    ) {
      lines.push(`+${newLines[next++]}`);
    } else {
      lines.push(`-${oldLines[old++]}`);
    }
  }
  return lines.join("\n");
}

/**
 * A GitHub pull request or GitLab merge request link, on any host: an https
 * URL whose path ends in `/pull/<n>` or `/-/merge_requests/<n>`.
 */
function changeRequestUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      /\/(?:pull|-\/merge_requests)\/\d+\/?$/.test(parsed.pathname)
      ? url
      : null;
  } catch {
    return null;
  }
}

function changeRequestNoun(url: string) {
  return url.includes("/-/merge_requests/") ? "merge request" : "pull request";
}

function changeRequestShort(url: string) {
  return url.includes("/-/merge_requests/") ? "MR" : "PR";
}
