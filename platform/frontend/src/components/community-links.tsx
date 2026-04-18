"use client";

import { COMMUNITY_SLACK_URL, GITHUB_REPO_URL } from "@shared";
import { Github, Slack } from "lucide-react";
import config from "@/lib/config/config";

/**
 * Compact community links (GitHub + Slack) for use outside the sidebar,
 * e.g. on the login page. Only renders in community edition.
 */
export function CommunityLinks() {
  if (config.enterpriseFeatures.fullWhiteLabeling) {
    return null;
  }

  return (
    <div className="flex items-center justify-center gap-4 text-sm text-muted-foreground">
      <a
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
      >
        <Github className="h-4 w-4" />
        <span>GitHub</span>
      </a>
      <a
        href={COMMUNITY_SLACK_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
      >
        <Slack className="h-4 w-4" />
        <span>Community</span>
      </a>
    </div>
  );
}
