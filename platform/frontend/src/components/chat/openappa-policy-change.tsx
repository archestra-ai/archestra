"use client";

import { ArrowUpRight, ChevronDown, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ToolInput, type ToolInputProps } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { validationPolicyHref } from "@/lib/openappa-policy-views";
import { cn } from "@/lib/utils/tailwind";
import {
  isPolicyPreviewTool,
  isPolicySaveTool,
  parsePolicyChange,
  parsePolicyDelivery,
  parsePolicyOutput,
} from "./openappa-policy-change.utils";
import { PolicyDiff } from "./policy-diff";
import { getPolicyDiffRows } from "./policy-diff-rows";

/**
 * A completed preview of a Guardrails change. The operator is asked to approve
 * what it shows: the policy's diff, or a validation change's replay results.
 */
export function isOpenAppaPreview({
  shortName,
  output,
  input,
}: {
  shortName: string | null;
  output: unknown;
  /** What the call sent: a result stored without its texts is read with it. */
  input?: unknown;
}): boolean {
  if (isPolicyPreviewTool(shortName))
    return isOpenAppaPolicyChange(output, false, input);
  return (
    shortName === "preview_guardrails_validation_change" &&
    parsePolicyOutput(output) !== null
  );
}

/**
 * What the model sent, under a diff or a save result and closed until asked
 * for: the card above it is what the reader came for.
 */
export function OpenAppaPolicyArguments({
  input,
}: Pick<ToolInputProps, "input">) {
  return (
    <Collapsible className="border-t">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="group m-3">
          <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
          <span>Arguments</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ToolInput input={input} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function OpenAppaPolicyChange({
  output,
  validationChange = false,
  input,
}: {
  output: unknown;
  validationChange?: boolean;
  /** What the call sent: a result stored without its texts is read with it. */
  input?: unknown;
}) {
  const change = parsePolicyChange(output, validationChange, input);
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
      {/* A validation change can touch any of several files, and a server's
          rules are one file of many; name it. The policy is always the one
          file, so its name says nothing. */}
      {(validationChange || change.mcpServer) && (
        <p className="font-mono text-xs text-muted-foreground">{path}</p>
      )}
      <PolicyDiff
        before={unchanged ? "" : change.before}
        after={change.after}
        path={path}
        rows={getPolicyDiffRows({
          before: change.before,
          after: change.after,
          // Previewing the unsaved starter changes no line: every line is new.
          diff: unchanged
            ? null
            : change.diff || policyDiff(change.before, change.after, path),
        })}
      />
      {change.rootChange ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            The pull request also adds the servers&apos; folder to the
            organization policy&apos;s include list:
          </p>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
            {change.rootChange}
          </pre>
        </div>
      ) : null}
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
          <InlineNoticeText>{policyErrorText(error)}</InlineNoticeText>
        </InlineNotice>
      ))}
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
  const change = parsePolicyDelivery(output);
  const url =
    change?.stage !== "preview" && change?.delivery === "pull_request"
      ? changeRequestUrl(change.url)
      : null;
  if (change && url) {
    return {
      tone: "success",
      title: `Opened ${changeRequestShort(url)} #${change.number}`,
      detail: change.autoMerge
        ? "it merges once its checks pass"
        : "merge it to apply",
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
  if (isPolicySaveTool(shortName)) {
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
 * What saved validations report: an opened pull request, or a local save and
 * its recorded run when present. Null for a preview or an unreadable result.
 */
export function getValidationSaveResult(output: unknown): SaveResult | null {
  const change = parsePolicyOutput(output);
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
  const run = validationRunResult(change.run);
  return {
    tone: run.tone,
    title:
      change.policyChanged === true
        ? "Saved policy and validations"
        : "Saved validations",
    detail: run.detail,
    action: {
      label: "View Validations",
      href: validationPolicyHref(run.targetPath),
      external: false,
    },
    local: true,
  };
}

function validationRunResult(
  run: unknown,
): Pick<SaveResult, "tone" | "detail"> & { targetPath: string | null } {
  if (run === undefined)
    return { tone: "success", detail: "not run yet", targetPath: null };
  if (run === null)
    return { tone: "success", detail: "saved", targetPath: null };
  if (!run || typeof run !== "object") {
    return { tone: "warning", detail: "could not run", targetPath: null };
  }
  const { files, executionError, validation } = run as {
    files?: unknown;
    executionError?: unknown;
    validation?: { valid?: unknown } | null;
  };
  const fileEntries = Array.isArray(files)
    ? files.map((file) => ({
        path:
          file &&
          typeof file === "object" &&
          "path" in file &&
          typeof file.path === "string" &&
          file.path.length > 0
            ? file.path
            : null,
        status:
          file && typeof file === "object" && "status" in file
            ? file.status
            : null,
      }))
    : [];
  const targetPath =
    fileEntries.find((file) => file.status === "failed" && file.path)?.path ??
    fileEntries.find((file) => file.status !== "passed" && file.path)?.path ??
    fileEntries.find((file) => file.path)?.path ??
    null;
  if (
    executionError ||
    validation?.valid === false ||
    fileEntries.length === 0
  ) {
    return { tone: "warning", detail: "could not run", targetPath };
  }
  const failed = fileEntries.filter((file) => file.status === "failed").length;
  if (failed > 0) {
    return {
      tone: "warning",
      detail:
        fileEntries.length === 1
          ? "failed"
          : `${failed} of ${fileEntries.length} failed`,
      targetPath,
    };
  }
  if (fileEntries.some((file) => file.status !== "passed")) {
    return { tone: "warning", detail: "could not run", targetPath };
  }
  return {
    tone: "success",
    detail:
      fileEntries.length === 1
        ? "passed"
        : `${fileEntries.length} of ${fileEntries.length} passed`,
    targetPath,
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
  input?: unknown,
): boolean {
  return parsePolicyChange(output, validationChange, input) !== null;
}

/**
 * The runtime prefixes a refused policy's error with "unsupported policy: ",
 * which the "Policy error" label already says. The backend matches on the
 * prefix, so it is dropped here, for display only.
 */
function policyErrorText(error: string): string {
  return error.replace(/^unsupported policy: /, "");
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
