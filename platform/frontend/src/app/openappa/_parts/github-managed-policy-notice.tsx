"use client";

import { ExternalLink, LockKeyhole } from "lucide-react";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";

export function GithubManagedPolicyNotice() {
  const { data } = useAppaGithubSync();
  const source = data?.source;
  const href =
    source?.repo && source.path
      ? `https://github.com/${source.repo}/blob/${encodeURIComponent(source.ref ?? "HEAD")}/${source.path.split("/").map(encodeURIComponent).join("/")}`
      : null;

  return (
    <InlineNotice variant="neutral">
      <LockKeyhole />
      <span className="font-medium">Managed in GitHub</span>
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
        owns this policy. Change its rules and batteries there.
      </InlineNoticeText>
    </InlineNotice>
  );
}
