"use client";

import type { GitProvider } from "@archestra/shared";
import {
  ChoiceTile,
  ChoiceTiles,
  GitProviderLogo,
  TileIcon,
} from "./git-setup-chrome";

/** First step of every Git setup: where the repository lives. */
export function GitProviderStep({
  onPick,
}: {
  onPick: (provider: GitProvider) => void;
}) {
  return (
    <ChoiceTiles>
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
    </ChoiceTiles>
  );
}
