import type { archestraApiTypes } from "@archestra/shared";

export type FileSource = "artifact" | "generated" | "attachment";

export type ConversationFileItem = {
  id: string;
  name: string;
  mimeType: string;
  /** Byte endpoint; empty for the synthesized artifact.md row (rendered in-memory). */
  contentUrl: string;
  source: FileSource;
};

type FilesResponse =
  | archestraApiTypes.GetChatConversationFilesResponses["200"]
  | null
  | undefined;

/**
 * Builds the two Files-panel sections from the API payload plus the in-memory
 * markdown artifact. `artifact.md` is synthesized client-side and always sits
 * first in the Generated section.
 */
export function assembleFileSections(params: {
  files: FilesResponse;
  artifact: string | null | undefined;
}): { generated: ConversationFileItem[]; attachments: ConversationFileItem[] } {
  const generated: ConversationFileItem[] = [];

  if (params.artifact && params.artifact.trim().length > 0) {
    generated.push({
      id: "artifact",
      name: "artifact.md",
      mimeType: "text/markdown",
      contentUrl: "",
      source: "artifact",
    });
  }

  for (const f of params.files?.generated ?? []) {
    generated.push({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      contentUrl: f.contentUrl,
      source: "generated",
    });
  }

  const attachments: ConversationFileItem[] = (
    params.files?.attachments ?? []
  ).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    contentUrl: f.contentUrl,
    source: "attachment",
  }));

  return { generated, attachments };
}
