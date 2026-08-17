"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback } from "react";
import {
  FileDropInput,
  fileToBase64,
  StagedFileList,
} from "@/components/files/file-drop-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useConnectors } from "@/lib/knowledge/connector.query";
import { useConnectorDocuments } from "@/lib/knowledge/kb-document.query";
import {
  KNOWLEDGE_FILE_ACCEPT,
  KNOWLEDGE_FILE_TYPES_LABEL,
} from "@/lib/knowledge/knowledge-file-accept";

const DOCUMENT_PAGE_SIZE = 100;

type PendingRow = NonNullable<
  archestraApiTypes.AddBatchAnalysisRowsData["body"]
>["rows"][number];

/**
 * Everything the user has typed or picked, held in one object so the parent can
 * derive the rows without the picker having to push them back up through an
 * effect.
 *
 * `selected` keys documents by id AND carries the title, rather than being
 * re-derived from the visible list: that list is one search-filtered page, so
 * deriving would silently drop a document picked before the search was refined
 * — and report the smaller count as success.
 */
export interface RowSourceDraft {
  tab: "upload" | "knowledge" | "text";
  files: File[];
  connectorId: string;
  search: string;
  selected: Map<string, string>;
  inlineLabel: string;
  inlineText: string;
}

export const EMPTY_ROW_SOURCE_DRAFT: RowSourceDraft = {
  tab: "upload",
  files: [],
  connectorId: "",
  search: "",
  selected: new Map(),
  inlineLabel: "",
  inlineText: "",
};

/** Whether the ACTIVE tab has anything to submit; gates the Add button. */
export function draftIsSubmittable(draft: RowSourceDraft): boolean {
  switch (draft.tab) {
    case "upload":
      return draft.files.length > 0;
    case "knowledge":
      return draft.selected.size > 0;
    case "text":
      return (
        draft.inlineLabel.trim().length > 0 &&
        draft.inlineText.trim().length > 0
      );
  }
}

/**
 * The rows a draft would create without any uploading. Reads only the ACTIVE
 * tab, so text typed and then abandoned for another tab is never submitted.
 * The upload tab yields nothing here — its rows only exist after the files are
 * uploaded, which is `useUploadRowSourceFiles`'s job.
 */
export function draftToRows(draft: RowSourceDraft): PendingRow[] {
  if (draft.tab === "text") {
    const label = draft.inlineLabel.trim();
    const text = draft.inlineText.trim();
    if (!label || !text) return [];
    return [{ label, source: { type: "inline_text", text } }];
  }
  if (draft.tab === "knowledge") {
    return [...draft.selected].map(([documentId, title]) => ({
      label: title,
      source: { type: "kb_document", documentId },
    }));
  }
  return [];
}

/**
 * Upload staged files into the knowledge repository and return the rows that
 * reference them.
 *
 * The repository is where the bytes go — not an inline copy — so every row's
 * source stays viewable after the analysis is created. Uploads are private to
 * the uploader: analysing a document must not publish it. A filename already
 * taken in the repository gets a " (2)" style suffix rather than failing —
 * the user's intent here is analysis, not repository curation. Failures
 * (unreadable files, exhausted retries) are collected per file so one bad
 * document never discards the ones that worked.
 */
export function useUploadRowSourceFiles() {
  const queryClient = useQueryClient();

  return useCallback(
    async (
      files: File[],
    ): Promise<{ rows: PendingRow[]; failures: string[] }> => {
      const rows: PendingRow[] = [];
      const failures: string[] = [];

      for (const file of files) {
        const content = await fileToBase64(file);
        let uploaded: { id: string } | undefined;

        for (let attempt = 0; attempt < 5 && !uploaded; attempt++) {
          const name = suffixedName(file.name, attempt);
          const { data, response } = await archestraApiSdk.uploadKnowledgeFile({
            body: {
              filename: name,
              mimeType: file.type || "application/octet-stream",
              content,
              directoryId: null,
              visibility: "private",
              teamIds: [],
            },
          });
          if (data) {
            uploaded = data;
            rows.push({
              label: name,
              source: { type: "kb_file", fileId: data.id },
            });
          } else if (response?.status !== 409) {
            // Not a name collision — retrying the same bytes cannot help.
            break;
          }
        }

        if (!uploaded) failures.push(file.name);
      }

      if (rows.length > 0) {
        queryClient.invalidateQueries({ queryKey: ["knowledge-files"] });
      }
      return { rows, failures };
    },
    [queryClient],
  );
}

export function RowSourcePicker({
  draft,
  onDraftChange,
}: {
  draft: RowSourceDraft;
  onDraftChange: (draft: RowSourceDraft) => void;
}) {
  const { data: connectors } = useConnectors();
  const { data: documentsPage } = useConnectorDocuments({
    path: { id: draft.connectorId },
    query: {
      limit: DOCUMENT_PAGE_SIZE,
      offset: 0,
      search: draft.search || undefined,
    },
  });

  const documents = documentsPage?.data ?? [];
  const patch = (changes: Partial<RowSourceDraft>) =>
    onDraftChange({ ...draft, ...changes });

  // Appends rather than replaces, and dedupes by name+size, so dropping a
  // second batch adds to the first instead of quietly discarding it.
  const addFiles = (incoming: File[]) => {
    const seen = new Set(draft.files.map((f) => `${f.name}:${f.size}`));
    patch({
      files: [
        ...draft.files,
        ...incoming.filter((f) => !seen.has(`${f.name}:${f.size}`)),
      ],
    });
  };

  const toggleDocument = (id: string, title: string) => {
    const selected = new Map(draft.selected);
    if (selected.has(id)) {
      selected.delete(id);
    } else {
      selected.set(id, title);
    }
    patch({ selected });
  };

  return (
    <Tabs
      value={draft.tab}
      onValueChange={(value) => patch({ tab: value as RowSourceDraft["tab"] })}
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      <TabsList className="self-start">
        <TabsTrigger value="upload">Upload files</TabsTrigger>
        <TabsTrigger value="knowledge">From knowledge</TabsTrigger>
        <TabsTrigger value="text">Paste text</TabsTrigger>
      </TabsList>

      <TabsContent value="upload" className="space-y-3">
        <FileDropInput
          accept={KNOWLEDGE_FILE_ACCEPT}
          typesLabel={KNOWLEDGE_FILE_TYPES_LABEL}
          onFiles={addFiles}
        />
        <StagedFileList
          files={draft.files}
          onRemove={(file) =>
            patch({ files: draft.files.filter((f) => f !== file) })
          }
        />
        <p className="text-muted-foreground text-xs">
          Each file becomes one row. Files are saved to your knowledge
          repository, visible only to you, so you can open a row's source any
          time.
        </p>
      </TabsContent>

      <TabsContent value="knowledge" className="space-y-3">
        <p className="text-muted-foreground text-xs">
          Documents already indexed by a knowledge connector — Jira issues,
          Confluence pages, Google Drive files.
        </p>
        {/* A select with zero items opens an empty, near-invisible popper,
            which reads as a dead control. Say why it is empty instead. */}
        {connectors && connectors.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center">
            <p className="text-muted-foreground text-sm">
              No knowledge connectors are set up yet.
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              Create one under{" "}
              <Link
                href="/knowledge/connectors"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Knowledge → Connectors
              </Link>{" "}
              to analyse synced documents, or upload files instead.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="row-source-connector">Connector</Label>
            <Select
              value={draft.connectorId}
              onValueChange={(connectorId) => patch({ connectorId })}
            >
              <SelectTrigger id="row-source-connector" className="w-full">
                <SelectValue placeholder="Select a connector" />
              </SelectTrigger>
              <SelectContent>
                {(connectors ?? []).map((connector) => (
                  <SelectItem key={connector.id} value={connector.id}>
                    {connector.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {draft.connectorId && (
          <>
            <Input
              placeholder="Search documents…"
              value={draft.search}
              onChange={(event) => patch({ search: event.target.value })}
            />
            <div className="max-h-[320px] space-y-1 overflow-y-auto rounded-md border p-2">
              {documents.length === 0 ? (
                <p className="p-2 text-muted-foreground text-sm">
                  No documents found.
                </p>
              ) : (
                documents.map((doc) => (
                  <label
                    key={doc.id}
                    htmlFor={`doc-${doc.id}`}
                    className="flex cursor-pointer items-start gap-2 rounded p-2 hover:bg-accent"
                  >
                    <Checkbox
                      id={`doc-${doc.id}`}
                      checked={draft.selected.has(doc.id)}
                      onCheckedChange={() => toggleDocument(doc.id, doc.title)}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {doc.title}
                    </span>
                  </label>
                ))
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              {draft.selected.size} selected
            </p>
          </>
        )}
      </TabsContent>

      <TabsContent value="text" className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="row-source-label">Label</Label>
          <Input
            id="row-source-label"
            placeholder="What this source is called in the table"
            value={draft.inlineLabel}
            onChange={(event) => patch({ inlineLabel: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="row-source-text">Text</Label>
          <Textarea
            id="row-source-text"
            rows={10}
            placeholder="Paste the source text…"
            value={draft.inlineText}
            onChange={(event) => patch({ inlineText: event.target.value })}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}

/** "report.pdf" → "report (2).pdf"; attempt 0 keeps the original name. */
function suffixedName(name: string, attempt: number): string {
  if (attempt === 0) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${stem} (${attempt + 1})${ext}`;
}
