"use client";

import type { GitProvider } from "@archestra/shared";
import { ChoiceTile, GitProviderLogo, TileIcon } from "./git-setup-chrome";

/** First step of every Git setup: where the repository lives. */
export function GitProviderStep({
  onPick,
}: {
  onPick: (provider: GitProvider) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ChoiceTile
        onClick={() => onPick("github")}
        visual={
          <TileIcon>
            <GitProviderLogo provider="github" />
          </TileIcon>
        }
        title="GitHub"
        body="github.com or GitHub Enterprise Server."
      />
      <ChoiceTile
        onClick={() => onPick("gitlab")}
        visual={
          <TileIcon>
            <GitProviderLogo provider="gitlab" />
          </TileIcon>
        }
        title="GitLab"
        body="gitlab.com or self-managed GitLab."
      />
    </div>
  );
}
