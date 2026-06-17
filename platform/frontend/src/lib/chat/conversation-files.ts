import type { archestraApiTypes } from "@archestra/shared";

export type FileSource = "artifact" | "generated" | "attachment" | "my-file";

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
 * Builds the Files-panel sections from the API payload plus the in-memory
 * markdown artifact. `artifact.md` is synthesized client-side and always sits
 * first in the Generated section. `myFiles` is everything the agent can
 * reach in persistent storage from this chat (project folder or personal
 * PFS), minus this conversation's own outputs.
 */
export function assembleFileSections(params: {
  files: FilesResponse;
  artifact: string | null | undefined;
}): {
  generated: ConversationFileItem[];
  attachments: ConversationFileItem[];
  myFiles: ConversationFileItem[];
  /** Title for the myFiles section: the project's files in a project chat. */
  myFilesTitle: string;
} {
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

  const myFiles: ConversationFileItem[] = (params.files?.myFiles ?? []).map(
    (f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      contentUrl: f.contentUrl,
      source: "my-file",
    }),
  );

  return {
    generated,
    attachments,
    myFiles,
    myFilesTitle: params.files?.projectName ? "Project files" : "My Files",
  };
}
