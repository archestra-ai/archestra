"use client";

import { Github, Slack } from "lucide-react";
import config from "@/lib/config";

export const COMMUNITY_GITHUB_URL = "https://github.com/archestra-ai/archestra";
export const COMMUNITY_SLACK_URL = "https://archestra.ai/join-slack";
export const COMMUNITY_DOCS_URL = "https://archestra.ai/docs/";
export const COMMUNITY_BUG_REPORT_URL =
  "https://github.com/archestra-ai/archestra/issues/new";

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
        href={COMMUNITY_GITHUB_URL}
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
