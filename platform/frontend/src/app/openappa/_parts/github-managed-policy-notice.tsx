"use client";

import {
  AlertTriangle,
  ExternalLink,
  GitPullRequestArrow,
  LockKeyhole,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { appaGitHost } from "./appa-git-host";

type AppaGithubSyncStatus = NonNullable<
  ReturnType<typeof useAppaGithubSync>["data"]
>;

export function GithubManagedPolicyNotice({
  validationDirectory,
  hideHealthy = false,
}: {
  validationDirectory?: string;
  /** The page links to the repository elsewhere; show only states that ask for something. */
  hideHealthy?: boolean;
} = {}) {
  const { data } = useAppaGithubSync();
  const git = appaGitHost(data);
  const source = data?.source;
  const failed = Boolean(source?.lastSyncError);
  const validations = validationDirectory !== undefined;
  const href = managedSourceUrl(data, validationDirectory);

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

  // A healthy sync asks for nothing, so it is a chip, not a banner.
  if (!failed && !(validations && validationDirectory === "")) {
    if (hideHealthy) return null;
    const content = (
      <>
        <LockKeyhole aria-hidden />
        <span>{`Managed in ${git.label}`}</span>
        {href && <ExternalLink aria-hidden />}
      </>
    );
    return (
      <Badge
        variant="outline"
        className="font-normal"
        title={`The ${git.repository} owns ${validations ? "these validations" : "this policy"}. Change ${validations ? "their files" : "it"} there.`}
        asChild={Boolean(href)}
      >
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {content}
            <span className="sr-only">(opens in new tab)</span>
          </a>
        ) : (
          <span>{content}</span>
        )}
      </Badge>
    );
  }

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

/** Where the validations (or, without a directory, the policy file) live in the repository. */
function managedSourceUrl(
  sync: AppaGithubSyncStatus | null | undefined,
  validationDirectory?: string,
) {
  const source = sync?.source;
  return validationDirectory !== undefined && source?.repo
    ? `${sync?.githubWebUrl}/${source.repo}${gitPathSeparator(sync)}/tree/${encodeURIComponent(source.ref ?? "HEAD")}/${validationDirectory.split("/").map(encodeURIComponent).join("/")}`
    : githubPolicyFileUrl(sync, "blob");
}

/** "Managed in GitHub" and the repository link, for a menu item standing in for the chip. */
export function useManagedValidationsLink(validationDirectory: string) {
  const { data } = useAppaGithubSync();
  return {
    label: `Managed in ${appaGitHost(data).label}`,
    href: managedSourceUrl(data, validationDirectory),
  };
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
