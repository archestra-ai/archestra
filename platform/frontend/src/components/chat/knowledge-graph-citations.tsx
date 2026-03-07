"use client";

import { ExternalLink, FileText } from "lucide-react";
import {
  ConnectorTypeIcon,
  hasConnectorIcon,
} from "@/app/knowledge/knowledge-bases/_parts/connector-icons";

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

interface ExtractedCitation {
  title: string;
  sourceUrl: string | null;
  connectorType: string | null;
  documentId: string;
}

function extractCitations(
  parts: KnowledgeGraphCitationsProps["parts"],
): ExtractedCitation[] {
  const seen = new Set<string>();
  const citations: ExtractedCitation[] = [];

  for (const part of parts) {
    const isKbTool =
      (typeof part.toolName === "string" &&
        part.toolName.endsWith(KNOWLEDGE_BASE_TOOL_SUFFIX)) ||
      (typeof part.type === "string" &&
        part.type.endsWith(KNOWLEDGE_BASE_TOOL_SUFFIX));

    if (!isKbTool || part.state !== "output-available") continue;

    let results: Array<{
      citation?: {
        title?: string;
        sourceUrl?: string | null;
        connectorType?: string | null;
        documentId?: string;
      };
    }> = [];

    try {
      const parsed =
        typeof part.output === "string" ? JSON.parse(part.output) : part.output;
      if (Array.isArray(parsed?.results)) {
        results = parsed.results;
      }
    } catch {
      continue;
    }

    for (const chunk of results) {
      const c = chunk.citation;
      if (!c?.documentId || seen.has(c.documentId)) continue;
      seen.add(c.documentId);
      citations.push({
        title: c.title ?? "Untitled",
        sourceUrl: c.sourceUrl ?? null,
        connectorType: c.connectorType ?? null,
        documentId: c.documentId,
      });
    }
  }

  return citations;
}

function SourceIcon({ connectorType }: { connectorType: string | null }) {
  if (connectorType && hasConnectorIcon(connectorType)) {
    return (
      <ConnectorTypeIcon type={connectorType} className="h-5 w-5 shrink-0" />
    );
  }
  return <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />;
}

export interface KnowledgeGraphCitationsProps {
  parts: Array<{
    type: string;
    toolName?: string;
    state?: string;
    output?: unknown;
  }>;
}

export function KnowledgeGraphCitations({
  parts,
}: KnowledgeGraphCitationsProps) {
  const citations = extractCitations(parts);

  if (citations.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Sources
      </p>
      <div className="flex flex-wrap gap-2">
        {citations.map((citation) => {
          const content = (
            <>
              <SourceIcon connectorType={citation.connectorType} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="font-medium text-xs text-foreground truncate">
                    {citation.title}
                  </span>
                  {citation.sourceUrl && (
                    <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  )}
                </div>
              </div>
            </>
          );

          if (citation.sourceUrl) {
            return (
              <a
                key={citation.documentId}
                href={citation.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-sm transition-colors hover:bg-accent hover:border-accent-foreground/20 max-w-xs"
              >
                {content}
              </a>
            );
          }

          return (
            <div
              key={citation.documentId}
              className="group flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-sm max-w-xs"
            >
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}
