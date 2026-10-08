"use client";

import {
  ArrowUpRight,
  CheckCircle2,
  FileText,
  GitPullRequest,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";

type PolicyChange = {
  stage?: "preview";
  delivery: "revision" | "pull_request";
  before: string;
  after: string;
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
  const counts = validationChange
    ? parseReplayCounts(parseOutput(output)?.counts)
    : null;
  const path = change.path ?? "organization.appa.toml";
  // Previewing the unsaved starter changes no line; show the policy itself.
  const unchanged = change.before === change.after;
  const pullUrl =
    change.delivery === "pull_request" &&
    change.url?.startsWith("https://github.com/")
      ? change.url
      : null;
  return (
    <div className="space-y-3 px-3 pb-3 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {change.stage === "preview" ? "Proposed policy" : "Policy change"}
        </span>
        <Badge variant="secondary">
          {change.stage === "preview"
            ? change.delivery === "pull_request"
              ? "GitHub pull request"
              : "Local revision"
            : change.delivery === "pull_request"
              ? `PR #${change.number}`
              : `Revision ${change.revision}`}
        </Badge>
        {pullUrl && (
          <Button variant="outline" size="sm" className="ml-auto" asChild>
            <a href={pullUrl} target="_blank" rel="noreferrer">
              <span>Review pull request</span>
              <ArrowUpRight className="size-3.5" />
            </a>
          </Button>
        )}
      </div>
      <p className="font-mono text-xs text-muted-foreground">{path}</p>
      {unchanged ? (
        <CodeBlock code={change.after} language="toml" aria-label="Policy">
          <CodeBlockCopyButton />
        </CodeBlock>
      ) : (
        <CodeBlock
          code={policyDiff(change.before, change.after, path)}
          language="diff"
          aria-label="Policy diff"
        >
          <CodeBlockCopyButton />
        </CodeBlock>
      )}
      {counts && (
        <InlineNotice variant={replayPassed(counts) ? "success" : "warning"}>
          {replayPassed(counts) ? <CheckCircle2 /> : <TriangleAlert />}
          <span className="font-medium">Draft replay</span>
          <InlineNoticeText>{replaySummary(counts)}</InlineNoticeText>
        </InlineNotice>
      )}
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
          <span className="font-medium">Validation error</span>
          <InlineNoticeText>{error}</InlineNoticeText>
        </InlineNotice>
      ))}
    </div>
  );
}

/** A published result stays visible even when tool details are collapsed. */
export function OpenAppaPolicyCompletion({ output }: { output: unknown }) {
  const change = parsePolicyChange(output);
  if (
    change?.stage !== "preview" &&
    change?.delivery === "pull_request" &&
    change.url?.startsWith("https://github.com/")
  ) {
    return (
      <div className="mt-4 w-full max-w-2xl">
        <InlineNotice variant="success">
          <GitPullRequest />
          <span className="font-medium">{`Opened PR #${change.number}`}</span>
          <InlineNoticeText>
            Review and merge it to apply this policy change.
          </InlineNoticeText>
          <Button variant="outline" size="xs" className="ml-auto" asChild>
            <a href={change.url} target="_blank" rel="noreferrer">
              Review pull request
            </a>
          </Button>
        </InlineNotice>
      </div>
    );
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
  return (
    <div className="mt-4 w-full max-w-2xl">
      <InlineNotice variant={active ? "success" : "warning"}>
        {active ? <CheckCircle2 /> : <TriangleAlert />}
        <span className="font-medium">{`Saved revision ${change.revision}`}</span>
        <InlineNoticeText>
          {active
            ? "Enforcement confirmed on. New conversations use this policy."
            : change.effective?.error ||
              change.enforcement?.reason ||
              (change.enforcement?.enabled === false
                ? "Enforcement is off. Check the Policy page."
                : "Check composition and enforcement on the Policy page.")}
        </InlineNoticeText>
        <Button variant="outline" size="xs" className="ml-auto" asChild>
          <Link href={active ? "/openappa" : "/openappa/policy"}>
            <span>{active ? "View Guardrails" : "Check policy"}</span>
          </Link>
        </Button>
      </InlineNotice>
    </div>
  );
}

export function OpenAppaValidationCompletion({ output }: { output: unknown }) {
  const change = parseOutput(output);
  if (!change || change.stage === "preview") return null;
  const counts = parseReplayCounts(change.counts);
  if (!counts) return null;
  const pullUrl =
    change.delivery === "pull_request" &&
    typeof change.url === "string" &&
    change.url.startsWith("https://github.com/") &&
    Number.isSafeInteger(change.number) &&
    (change.number as number) > 0
      ? change.url
      : null;
  if (
    !pullUrl &&
    (change.delivery !== "revision" ||
      typeof change.version !== "string" ||
      !change.version)
  )
    return null;
  const healthy = replayPassed(counts);
  const replay = `Draft replay: ${replaySummary(counts)}`;
  return (
    <div className="mt-4 w-full max-w-2xl">
      <InlineNotice variant={healthy ? "success" : "warning"}>
        {pullUrl ? (
          <GitPullRequest />
        ) : healthy ? (
          <CheckCircle2 />
        ) : (
          <TriangleAlert />
        )}
        <span className="font-medium">
          {pullUrl
            ? `Opened PR #${change.number}`
            : change.policyChanged === true
              ? "Saved policy and validations"
              : "Saved validations"}
        </span>
        <InlineNoticeText>
          {pullUrl
            ? `Review and merge to apply these changes. ${replay}`
            : replay}
        </InlineNoticeText>
        <Button variant="outline" size="xs" className="ml-auto" asChild>
          {pullUrl ? (
            <a href={pullUrl} target="_blank" rel="noreferrer">
              <span>Review pull request</span>
            </a>
          ) : (
            <Link href="/openappa/validation">
              <span>View Validations</span>
            </Link>
          )}
        </Button>
      </InlineNotice>
    </div>
  );
}

type ReplayCounts = { passed: number; failed: number; cannotRun: number };

function parseReplayCounts(value: unknown): ReplayCounts | null {
  if (!value || typeof value !== "object") return null;
  const counts = value as Record<string, unknown>;
  if (
    ![counts.passed, counts.failed, counts.cannotRun].every(
      (count) =>
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    )
  )
    return null;
  return counts as ReplayCounts;
}

function replayPassed(counts: ReplayCounts) {
  return counts.failed === 0 && counts.cannotRun === 0 && counts.passed > 0;
}

function replaySummary(counts: ReplayCounts) {
  return `${counts.passed} passed, ${counts.failed} failed, ${counts.cannotRun} could not run.`;
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
  let value = parseOutput(output);
  if (!value) return null;
  if (validationChange) {
    if (value.stage === "preview") {
      const policy = value.policy;
      if (
        !policy ||
        typeof policy !== "object" ||
        !("changed" in policy) ||
        policy.changed !== true
      )
        return null;
      value = { ...value, ...policy };
    } else if (value.before === value.after) {
      return null;
    }
  }
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
