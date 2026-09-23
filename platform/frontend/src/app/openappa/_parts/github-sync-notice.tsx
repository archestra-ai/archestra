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
      <InlineNotice
        variant="info"
        className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 sm:flex sm:items-center"
      >
        <Github />
        <span className="min-w-0 font-medium">
          Review policy changes in GitHub
        </span>
        <InlineNoticeText className="col-start-2 sm:flex-1">
          Connect a repository and GitHub App to let the agent open pull
          requests.
        </InlineNoticeText>
        {canManage && sync.data?.enabled && (
          <Button
            variant="outline"
            size="sm"
            className="col-start-2 h-6 justify-self-start px-2 text-xs sm:ml-auto"
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
