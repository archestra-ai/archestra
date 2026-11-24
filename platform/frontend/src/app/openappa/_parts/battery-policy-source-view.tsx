"use client";

import type { OnMount } from "@monaco-editor/react";
import { ExternalLink, LockKeyhole } from "lucide-react";
import { useCallback } from "react";
import { Editor } from "@/components/editor";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useBatteryPolicySource } from "@/lib/openappa-batteries.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { batteryDisplayName } from "./battery-display-name";
import { githubRepositoryFileUrl } from "./github-managed-policy-notice";
import { focusPolicyLine } from "./policy-decorations";
import { POLICY_EDITOR_OPTIONS } from "./policy-editor-options";

/**
 * Read-only source for one include: the exact battery a tool rule links to,
 * or a file of the policy repository the root folds in, edited there.
 */
export function BatteryPolicySourceView({
  entry,
  focusLine,
}: {
  entry: string;
  focusLine?: number;
}) {
  const source = useBatteryPolicySource(entry);
  const sync = useAppaGithubSync();
  const onMount = useCallback<OnMount>(
    (editor) => {
      focusPolicyLine(editor, focusLine);
    },
    [focusLine],
  );

  if (source.isPending)
    return <Skeleton className="h-72 w-full rounded-t-none" />;
  if (source.isError || !source.data)
    return (
      <QueryLoadError
        title="Could not load battery policy source"
        error={source.error}
        onRetry={() => source.refetch()}
      />
    );

  const file = source.data.kind === "repository";
  const name = file ? source.data.name : batteryDisplayName(source.data.name);
  const editUrl = file
    ? githubRepositoryFileUrl(sync.data, source.data.entry, "edit")
    : null;

  return (
    <section
      aria-label={
        file ? `${name} policy file source` : `${name} battery policy source`
      }
      className="overflow-hidden rounded-b-lg border bg-background"
    >
      {file ? (
        <InlineNotice variant="neutral">
          <LockKeyhole aria-hidden />
          <span className="font-medium">Read-only source</span>
          <InlineNoticeText>
            Change this file in its connected repository.
          </InlineNoticeText>
          {editUrl ? (
            <Button asChild size="xs" variant="outline" className="ml-auto">
              <a href={editUrl} target="_blank" rel="noopener noreferrer">
                <span>Edit in repository</span>
                <ExternalLink aria-hidden />
              </a>
            </Button>
          ) : null}
        </InlineNotice>
      ) : null}
      <Editor
        height="min(50vh, 560px)"
        language="ini"
        value={source.data.content}
        onMount={onMount}
        options={{
          ...POLICY_EDITOR_OPTIONS,
          readOnly: true,
          ariaLabel: file ? `${name} TOML` : `${name} battery policy TOML`,
        }}
      />
    </section>
  );
}
