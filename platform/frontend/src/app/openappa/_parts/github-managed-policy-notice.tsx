"use client";

import {
  AlertTriangle,
  ExternalLink,
  GitPullRequestArrow,
  LockKeyhole,
} from "lucide-react";
import Link from "next/link";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { appaGitHost } from "./appa-git-host";

type AppaGithubSyncStatus = NonNullable<
  ReturnType<typeof useAppaGithubSync>["data"]
>;

export function GithubManagedPolicyNotice({
  validationDirectory,
}: {
  validationDirectory?: string;
} = {}) {
  const { data } = useAppaGithubSync();
  const git = appaGitHost(data);
  const source = data?.source;
  const failed = Boolean(source?.lastSyncError);
  const validations = validationDirectory !== undefined;
  const href =
    validations && source?.repo
      ? `${data?.githubWebUrl}/${source.repo}${gitPathSeparator(data)}/tree/${encodeURIComponent(source.ref ?? "HEAD")}/${validationDirectory.split("/").map(encodeURIComponent).join("/")}`
      : githubPolicyFileUrl(data, "blob");

  // Setup isn't finished until its pull (merge) request merges: ask for that.
  if (!failed && source?.repo && source.setupPullRequestNumber)
    return (
      <InlineNotice variant="info">
        <GitPullRequestArrow aria-hidden />
        <span className="font-medium">Merge your initial policy</span>
        <InlineNoticeText className="flex-1">
          Your current policy stays active until it merges.
        </InlineNoticeText>
        <a
          href={git
            .urls(source.repo)
            .changeRequest(source.setupPullRequestNumber)}
          target="_blank"
          rel="noreferrer"
          data-slot="inline-notice-action"
          className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-medium underline-offset-4 hover:underline"
        >
          <span>Review and merge {git.changeRequestShort}</span>
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </InlineNotice>
    );

  return (
    <InlineNotice variant={failed ? "error" : "neutral"}>
      {failed ? <AlertTriangle /> : <LockKeyhole />}
      <span className="font-medium">
        {failed ? "Git sync failed" : `Managed in ${git.label}`}
      </span>
      <InlineNoticeText>
        The{" "}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
          >
            <span>repository</span>
            <ExternalLink className="size-3" aria-hidden />
            <span className="sr-only">(opens in new tab)</span>
          </a>
        ) : (
          <span>repository</span>
        )}{" "}
        <span>
          {validations
            ? failed
              ? "owns these validations, but its updates could not be synced."
              : validationDirectory
                ? "owns these validations. Change their files there."
                : "owns these validations. Validations are disabled until you set a directory in sync settings."
            : failed
              ? "owns this policy, but its updates could not be synced."
              : "owns this policy. Change its rules and batteries there."}
        </span>
        {(failed || validationDirectory === "") && (
          <>
            {" "}
            <Link
              href="/settings/guardrails"
              className="underline underline-offset-2 hover:no-underline"
            >
              Review sync settings
            </Link>
            <span>.</span>
          </>
        )}
      </InlineNoticeText>
    </InlineNotice>
  );
}

/** The synced policy file on GitHub or GitLab, to read (`blob`) or to change (`edit`). */
export function githubPolicyFileUrl(
  sync: AppaGithubSyncStatus | null | undefined,
  view: "blob" | "edit",
): string | null {
  const source = sync?.source;
  if (!sync || !source?.repo || !source.path) return null;
  const path = source.path.split("/").map(encodeURIComponent).join("/");
  return `${sync.githubWebUrl}/${source.repo}${gitPathSeparator(sync)}/${view}/${encodeURIComponent(source.ref ?? "HEAD")}/${path}`;
}

/** GitLab puts `/-` before a project's tree, blob, and edit pages. */
function gitPathSeparator(
  sync: Pick<AppaGithubSyncStatus, "provider"> | null | undefined,
) {
  return sync?.provider === "gitlab" ? "/-" : "";
}
