"use client";

import { ExternalLink } from "lucide-react";

interface Citation {
  title: string;
  description: string;
  url: string;
  source: "jira" | "confluence";
}

const MOCK_CITATIONS: Citation[] = [
  {
    title: "DMRI-1",
    description: "[CONFIDENTIAL] Cast Details for Lilo & Stitch VI",
    url: "https://archestra-team-u99jg64i.atlassian.net/browse/DMRI-1",
    source: "jira",
  },
  {
    title: "Lilo & Stitch VI: The Quantum Ohana",
    description: "Production script overview and story treatment",
    url: "https://archestra-team-u99jg64i.atlassian.net/wiki/x/AYD6AQ",
    source: "confluence",
  },
];

const KNOWLEDGE_BASE_TOOL_SUFFIX = "query_knowledge_base";

export function hasKnowledgeBaseToolCall(
  parts: Array<{ type: string; toolName?: string }>,
): boolean {
  return parts.some((part) => {
    // dynamic-tool parts have toolName directly
    if (
      typeof part.toolName === "string" &&
      part.toolName.endsWith(KNOWLEDGE_BASE_TOOL_SUFFIX)
    ) {
      return true;
    }
    // Legacy tool parts have type like "tool-archestra__query_knowledge_base"
    if (
      typeof part.type === "string" &&
      part.type.endsWith(KNOWLEDGE_BASE_TOOL_SUFFIX)
    ) {
      return true;
    }
    return false;
  });
}

function JiraIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Jira"
    >
      <path
        d="M11.53 2C11.53 2 4.24 8.9 3.06 10.04C1.88 11.18 1.88 13.06 3.06 14.19L9.85 20.69C10.44 21.25 11.25 21.57 12.09 21.57C12.93 21.57 13.74 21.25 14.33 20.69L21.12 14.19C22.3 13.06 22.3 11.18 21.12 10.04L14.33 3.54C14.33 3.54 12.46 2 11.53 2Z"
        fill="#2684FF"
      />
      <path
        d="M11.53 2C11.53 2 9.66 8.37 12.09 10.69C14.52 13.02 20.18 10.69 20.18 10.69L14.33 3.54C14.33 3.54 12.46 2 11.53 2Z"
        fill="url(#jira_gradient_a)"
      />
      <path
        d="M12.65 13.55C10.22 11.22 11.53 2 11.53 2L3.06 10.04C3.06 10.04 8.73 12.37 12.65 13.55Z"
        fill="url(#jira_gradient_b)"
      />
      <defs>
        <linearGradient
          id="jira_gradient_a"
          x1="11.08"
          y1="6.35"
          x2="17.63"
          y2="10.35"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#0052CC" stopOpacity="0" />
          <stop offset="1" stopColor="#0052CC" />
        </linearGradient>
        <linearGradient
          id="jira_gradient_b"
          x1="13.08"
          y1="7.8"
          x2="6.53"
          y2="11.8"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#0052CC" stopOpacity="0" />
          <stop offset="1" stopColor="#0052CC" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function ConfluenceIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Confluence"
    >
      <path
        d="M3.28 16.05C3.04 16.42 2.78 16.84 2.56 17.18C2.28 17.62 2.42 18.2 2.86 18.48L6.52 20.62C6.96 20.9 7.54 20.76 7.82 20.32C8.02 19.99 8.26 19.6 8.52 19.2C10.04 16.72 11.56 17.08 14.26 18.24L17.86 19.8C18.32 20 18.86 19.8 19.06 19.34L20.88 15.22C21.08 14.76 20.88 14.22 20.42 14.02C19.34 13.54 17.38 12.68 16.06 12.12C10.96 9.92 6.86 10.24 3.28 16.05Z"
        fill="#2684FF"
      />
      <path
        d="M20.72 7.95C20.96 7.58 21.22 7.16 21.44 6.82C21.72 6.38 21.58 5.8 21.14 5.52L17.48 3.38C17.04 3.1 16.46 3.24 16.18 3.68C15.98 4.01 15.74 4.4 15.48 4.8C13.96 7.28 12.44 6.92 9.74 5.76L6.14 4.2C5.68 4 5.14 4.2 4.94 4.66L3.12 8.78C2.92 9.24 3.12 9.78 3.58 9.98C4.66 10.46 6.62 11.32 7.94 11.88C13.04 14.08 17.14 13.76 20.72 7.95Z"
        fill="#2684FF"
      />
    </svg>
  );
}

function SourceIcon({ source }: { source: Citation["source"] }) {
  if (source === "jira") {
    return <JiraIcon className="h-5 w-5 shrink-0" />;
  }
  return <ConfluenceIcon className="h-5 w-5 shrink-0" />;
}

export function KnowledgeGraphCitations() {
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Sources
      </p>
      <div className="flex flex-wrap gap-2">
        {MOCK_CITATIONS.map((citation) => (
          <a
            key={citation.url}
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            className="group flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-sm transition-colors hover:bg-accent hover:border-accent-foreground/20 max-w-xs"
          >
            <SourceIcon source={citation.source} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="font-medium text-xs text-muted-foreground">
                  {citation.title}
                </span>
                <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </div>
              <p className="text-xs text-foreground truncate">
                {citation.description}
              </p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
