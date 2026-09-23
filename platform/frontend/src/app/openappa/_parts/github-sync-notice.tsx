"use client";

import { Github } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { OpenAppaSourceForm } from "./appa-github-sync-panel";

export function GithubSyncNotice() {
  const [editing, setEditing] = useState(false);
  const sync = useAppaGithubSync();
  const { data: canManage } = useHasPermissions({ organization: ["update"] });
  if (sync.isPending || sync.isError || sync.data?.source?.interval)
    return null;
  return (
    <>
      <InlineNotice variant="info" className="gap-2">
        <Github />
        <span className="font-medium">Review policy changes in GitHub</span>
        <InlineNoticeText className="flex-1">
          Connect a repository and GitHub App to let the agent open pull
          requests.
        </InlineNoticeText>
        {canManage && sync.data?.enabled && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setEditing(true)}
          >
            Set up GitHub sync
          </Button>
        )}
      </InlineNotice>
      {editing && (
        <OpenAppaSourceForm
          source={sync.data?.source ?? null}
          onOpenChange={setEditing}
        />
      )}
    </>
  );
}
