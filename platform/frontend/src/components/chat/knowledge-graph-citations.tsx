"use client";

import {
  type ChatMessagePart,
  type CitationSourceEntry,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import { ChevronDown, ChevronUp, ExternalLink, FileText } from "lucide-react";
import { useState } from "react";
import {
  ConnectorTypeIcon,
  hasConnectorIcon,
} from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { Button } from "@/components/ui/button";
import { getToolNameFromPart } from "@/lib/chat/chat-tools-display.utils";

export function hasKnowledgeBaseToolCall(parts: ChatMessagePart[]): boolean {
  return parts.some(isKnowledgeBaseQueryPart);
}

/**
 * True when the part is a `query_knowledge_sources` call — either invoked
 * directly, or dispatched through the Auto-tool-mode `run_tool` wrapper. In
 * Auto mode the part is named after the dispatcher and the real tool only
 * appears in the call input's `tool_name`, so matching on the part name alone
 * would miss every KB query made by an Auto-mode agent.
 */
function isKnowledgeBaseQueryPart(part: ChatMessagePart): boolean {
  const partToolName = getToolNameFromPart(part);
  if (!partToolName) return false;
  if (partToolName.endsWith(TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME)) {
    return true;
  }
  if (partToolName.endsWith(TOOL_RUN_TOOL_SHORT_NAME)) {
    const dispatched = (part.input as { tool_name?: unknown } | undefined)
      ?.tool_name;
    return (
      typeof dispatched === "string" &&
      dispatched.endsWith(TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME)
    );
  }
  return false;
}

export interface ExtractedCitation {
  title: string;
  sourceUrl: string | null;
  connectorType: string | null;
  documentId: string;
  sourceId: string | null;
}

export function extractCitations(
  parts: KnowledgeGraphCitationsProps["parts"],
): ExtractedCitation[] {
  const seen = new Set<string>();
  const citations: ExtractedCitation[] = [];

  for (const part of parts) {
    if (!isKnowledgeBaseQueryPart(part) || part.state !== "output-available") {
      continue;
    }

    let results: Array<{
      citation?: {
        title?: string;
        sourceUrl?: string | null;
        connectorType?: string | null;
        documentId?: string;
        sourceId?: string | null;
      };
    }> = [];

    try {
      const parsed = parseToolOutput(part.output);
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
        sourceId: c.sourceId ?? null,
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

/** An image a knowledge query retrieved, ready to render inline. */
interface RetrievedImage {
  /** `documentId#chunkIndex` — stable per retrieved chunk. */
  key: string;
  src: string;
  alt: string;
}

const DISPLAYABLE_IMAGE_MIME_TYPE = /^image\/(png|jpe?g|webp|gif)$/;

/**
 * Images a knowledge query returned. The tool result carries them as MCP image
 * blocks on `rawContent` (its `content` text holds only an
 * `[image: title (mime)]` descriptor), and the persist path keeps a bounded
 * copy, so this renders both live and on reload. Blocks whose payload was
 * stripped for context — or whose type is not an image format we display — are
 * skipped rather than rendered broken.
 */
function extractRetrievedImages(
  parts: KnowledgeGraphCitationsProps["parts"],
): RetrievedImage[] {
  const images: RetrievedImage[] = [];
  // A model may call the knowledge tool repeatedly with related queries. The
  // same retrieved image then arrives under different toolCallIds; dedupe by
  // payload, not call identity, while keeping genuinely distinct images.
  const seenPayloads = new Set<string>();

  for (const part of parts) {
    if (!isKnowledgeBaseQueryPart(part) || part.state !== "output-available") {
      continue;
    }
    const output = part.output;
    if (!output || typeof output !== "object") continue;
    const rawContent = (output as { rawContent?: unknown }).rawContent;
    if (!Array.isArray(rawContent)) continue;

    rawContent.forEach((block, index) => {
      if (!block || typeof block !== "object") return;
      const { type, data, mimeType } = block as Record<string, unknown>;
      if (
        type !== "image" ||
        typeof data !== "string" ||
        typeof mimeType !== "string" ||
        !DISPLAYABLE_IMAGE_MIME_TYPE.test(mimeType) ||
        // The context stripper replaces a dropped payload with a short notice.
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
      ) {
        return;
      }
      if (seenPayloads.has(data)) return;
      seenPayloads.add(data);
      images.push({
        key: `${getToolCallId(part) ?? "kb"}#${index}`,
        src: `data:${mimeType};base64,${data}`,
        alt: "Image retrieved from the knowledge base",
      });
    });
  }

  return images;
}

function getToolCallId(part: ChatMessagePart): string | null {
  const id = (part as { toolCallId?: unknown }).toolCallId;
  return typeof id === "string" ? id : null;
}

export interface KnowledgeGraphCitationsProps {
  parts: ChatMessagePart[];
  /**
   * Quote entries folded out of the answer's Sources block
   * (foldCitationSources). When a chip's document has entries, the chip
   * expands to show the verbatim quotes backing the superscript markers.
   */
  citedQuotes?: CitationSourceEntry[];
}

const VISIBLE_COUNT = 3;

const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

function markerSuperscript(marker: number): string {
  return String(marker)
    .split("")
    .map((d) => SUPERSCRIPT_DIGITS[Number(d)] ?? d)
    .join("");
}

function CitationChip({
  citation,
  quotes,
  expanded,
  onToggle,
}: {
  citation: ExtractedCitation;
  quotes: CitationSourceEntry[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const content = (
    <>
      <SourceIcon connectorType={citation.connectorType} />
      <span className="font-medium text-xs text-foreground truncate max-w-[200px]">
        {citation.title}
      </span>
      {quotes.length > 0 ? (
        <>
          <span className="text-muted-foreground shrink-0">
            {quotes.map((q) => markerSuperscript(q.marker)).join(" ")}
          </span>
          {expanded ? (
            <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
        </>
      ) : (
        citation.sourceUrl && (
          <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
        )
      )}
    </>
  );

  // A chip whose document has backing quotes toggles them open; the source
  // link moves into the expanded panel so the chip stays a single control.
  if (quotes.length > 0) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:border-accent-foreground/20 max-w-[260px]"
      >
        {content}
      </button>
    );
  }

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
  citedQuotes,
}: KnowledgeGraphCitationsProps) {
  const [expanded, setExpanded] = useState(false);
  const [openDocIds, setOpenDocIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const citations = extractCitations(parts);
  const retrievedImages = extractRetrievedImages(parts);

  if (citations.length === 0 && retrievedImages.length === 0) return null;

  const quotesByDoc = new Map<string, CitationSourceEntry[]>();
  for (const entry of citedQuotes ?? []) {
    const list = quotesByDoc.get(entry.documentId) ?? [];
    list.push(entry);
    quotesByDoc.set(entry.documentId, list);
  }

  const toggleDoc = (documentId: string) => {
    setOpenDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(documentId)) {
        next.delete(documentId);
      } else {
        next.add(documentId);
      }
      return next;
    });
  };

  const hasMore = citations.length > VISIBLE_COUNT;
  const visibleCitations = expanded
    ? citations
    : citations.slice(0, VISIBLE_COUNT);
  const hiddenCount = citations.length - VISIBLE_COUNT;
  const openCitations = visibleCitations.filter(
    (citation) =>
      openDocIds.has(citation.documentId) &&
      (quotesByDoc.get(citation.documentId)?.length ?? 0) > 0,
  );

  return (
    <div className="mt-3 space-y-1.5">
      {retrievedImages.length > 0 && (
        <div className="flex flex-wrap gap-2 pb-1">
          {retrievedImages.map((image) => (
            // biome-ignore lint/performance/noImgElement: the payload is an
            // inline data URI from the tool result, not a served asset.
            <img
              key={image.key}
              src={image.src}
              alt={image.alt}
              className="max-h-80 max-w-full rounded-md border object-contain"
            />
          ))}
        </div>
      )}
      {citations.length > 0 && (
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Sources
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {visibleCitations.map((citation) => (
          <CitationChip
            key={citation.documentId}
            citation={citation}
            quotes={quotesByDoc.get(citation.documentId) ?? []}
            expanded={openDocIds.has(citation.documentId)}
            onToggle={() => toggleDoc(citation.documentId)}
          />
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
                <span>Show less</span>
                <ChevronUp className="ml-1 h-3 w-3" />
              </>
            ) : (
              <>
                <span>+{hiddenCount} more</span>
                <ChevronDown className="ml-1 h-3 w-3" />
              </>
            )}
          </Button>
        )}
      </div>
      {openCitations.map((citation) => (
        <div
          key={citation.documentId}
          className="rounded-md border bg-card px-3 py-2 text-xs space-y-1"
        >
          <p className="font-medium text-foreground">{citation.title}</p>
          {(quotesByDoc.get(citation.documentId) ?? []).map((entry) => (
            <p
              key={`${entry.marker}-${entry.ref}`}
              className="text-muted-foreground"
            >
              <span className="font-medium text-foreground">
                {markerSuperscript(entry.marker)}
              </span>
              <span> “{entry.quote}”</span>
            </p>
          ))}
          {citation.sourceUrl && (
            <a
              href={citation.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <span>Open source</span>
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

// A tool result reaches the UI either as the raw JSON string a platform tool
// returned, or wrapped in the MCP output object (which carries that same JSON
// as `content`, alongside metadata such as the identity the call ran as).
function parseToolOutput(
  output: unknown,
): { results?: unknown; tool_result?: unknown } | null {
  if (typeof output === "string") {
    return JSON.parse(output);
  }
  if (output && typeof output === "object") {
    // A result carrying an image appends a "[image]" marker line to `content`,
    // which makes it invalid JSON — the tool's structured copy is the clean
    // one, so prefer it whenever it is present.
    const structured = (output as { structuredContent?: unknown })
      .structuredContent;
    if (structured && typeof structured === "object") {
      return structured as { results?: unknown; tool_result?: unknown };
    }
    const content = (output as { content?: unknown }).content;
    if (typeof content === "string") {
      return JSON.parse(content);
    }
    return output as { results?: unknown; tool_result?: unknown };
  }
  return null;
}
