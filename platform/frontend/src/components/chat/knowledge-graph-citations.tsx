"use client";

import { ChevronDown, ChevronUp, ExternalLink, FileText } from "lucide-react";
import { useState } from "react";
import {
  ConnectorTypeIcon,
  hasConnectorIcon,
} from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { Button } from "@/components/ui/button";

const KNOWLEDGE_BASE_TOOL_SUFFIX = "query_knowledge_sources";

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
    // Legacy tool parts have type like "tool-archestra__query_knowledge_sources"
    if (
      typeof part.type === "string" &&
      part.type.endsWith(KNOWLEDGE_BASE_TOOL_SUFFIX)
    ) {
      return true;
    }
    return false;
  });
}

export interface ExtractedCitation {
  title: string;
  sourceUrl: string | null;
  connectorType: string | null;
  documentId: string;
}

export function extractCitations(
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
      } else if (typeof parsed?.tool_result === "string") {
        // MCP Gateway wraps results as: "name: <tool>\ncontent: \"<json>\""
        const contentMatch = parsed.tool_result.match(
          /content: "((?:[^"\\]|\\.)*)"/,
        );
        if (contentMatch) {
          const inner = JSON.parse(
            contentMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
          );
          if (Array.isArray(inner?.results)) {
            results = inner.results;
          }
        }
      }
    } catch (err) {
      console.warn("Failed to extract citations from tool result", err);
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
      <ConnectorTypeIcon type={connectorType} className="h-4 w-4 shrink-0" />
    );
  }
  return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

export interface KnowledgeGraphCitationsProps {
  parts: Array<{
    type: string;
    toolName?: string;
    state?: string;
    output?: unknown;
  }>;
}

const VISIBLE_COUNT = 3;

function CitationChip({ citation }: { citation: ExtractedCitation }) {
  const content = (
    <>
      <SourceIcon connectorType={citation.connectorType} />
      <span className="font-medium text-xs text-foreground truncate max-w-[200px]">
        {citation.title}
      </span>
      {citation.sourceUrl && (
        <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      )}
    </>
  );

  if (citation.sourceUrl) {
    return (
      <a
        href={citation.sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="group inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:border-accent-foreground/20 max-w-[260px]"
      >
        {content}
      </a>
    );
  }

  return (
    <div className="group inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1.5 text-xs max-w-[260px]">
      {content}
    </div>
  );
}

export function KnowledgeGraphCitations({
  parts,
}: KnowledgeGraphCitationsProps) {
  const [expanded, setExpanded] = useState(false);
  const citations = extractCitations(parts);

  if (citations.length === 0) return null;

  const hasMore = citations.length > VISIBLE_COUNT;
  const visibleCitations = expanded
    ? citations
    : citations.slice(0, VISIBLE_COUNT);
  const hiddenCount = citations.length - VISIBLE_COUNT;

  return (
    <div className="mt-3 space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Sources
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {visibleCitations.map((citation) => (
          <CitationChip key={citation.documentId} citation={citation} />
        ))}
        {hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <>
                Show less
                <ChevronUp className="ml-1 h-3 w-3" />
              </>
            ) : (
              <>
                +{hiddenCount} more
                <ChevronDown className="ml-1 h-3 w-3" />
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
