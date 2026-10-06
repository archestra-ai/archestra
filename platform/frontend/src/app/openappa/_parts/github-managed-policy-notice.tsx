"use client";

import { AlertTriangle, ExternalLink, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";

type AppaGithubSource = NonNullable<
  NonNullable<ReturnType<typeof useAppaGithubSync>["data"]>["source"]
>;

export function GithubManagedPolicyNotice() {
  const { data } = useAppaGithubSync();
  const source = data?.source;
  const failed = Boolean(source?.lastSyncError);
  const href = githubPolicyFileUrl(source, "blob");

  return (
    <InlineNotice variant={failed ? "error" : "neutral"}>
      {failed ? <AlertTriangle /> : <LockKeyhole />}
      <span className="font-medium">
        {failed ? "GitHub sync failed" : "Managed in GitHub"}
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
          {failed
            ? "owns this policy, but its updates could not be synced."
            : "owns this policy. Change its rules and batteries there."}
        </span>
        {failed && (
          <>
            {" "}
            <Link
              href="/settings/openappa"
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

/** The synced policy file on GitHub, to read (`blob`) or to change (`edit`). */
export function githubPolicyFileUrl(
  source: AppaGithubSource | null | undefined,
  view: "blob" | "edit",
): string | null {
  if (!source?.repo || !source.path) return null;
  const path = source.path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${source.repo}/${view}/${encodeURIComponent(source.ref ?? "HEAD")}/${path}`;
}
