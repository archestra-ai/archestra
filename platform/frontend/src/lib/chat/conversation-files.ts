import type { archestraApiTypes } from "@archestra/shared";

export type FileSource = "artifact" | "generated" | "attachment" | "project";

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
 * first in the Generated section. `projectFiles` is every file in the chat's
 * project (project chats only), minus this conversation's own outputs; it is
 * empty for a personal chat.
 */
export function assembleFileSections(params: {
  files: FilesResponse;
  artifact: string | null | undefined;
}): {
  generated: ConversationFileItem[];
  attachments: ConversationFileItem[];
  projectFiles: ConversationFileItem[];
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

  const projectFiles: ConversationFileItem[] = (
    params.files?.projectFiles ?? []
  ).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    contentUrl: f.contentUrl,
    source: "project",
  }));

  return { generated, attachments, projectFiles };
}

/**
 * Which delete endpoint removes a given file. Attachments have their own chat
 * route; generated and project files are both persisted artifacts behind the
 * skill-sandbox artifact route.
 */
export function deleteTargetFor(
  item: ConversationFileItem,
): { kind: "artifact" } | { kind: "attachment" } {
  return item.source === "attachment"
    ? { kind: "attachment" }
    : { kind: "artifact" };
}
