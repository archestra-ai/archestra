import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import { AppModel, ConversationModel } from "@/models";
import { FileBytesMissingError } from "@/skills-sandbox/file-storage";
import { fileStore } from "@/skills-sandbox/file-store";
import { resolveProjectFileScope } from "@/skills-sandbox/project-file-scope";
import { ApiError } from "@/types";

/**
 * Raw bytes of one chat-scoped file for a rendered app — the backing of the
 * SDK's `archestra.files.read`. The chat model's file tools must render for an
 * LLM, so they refuse binary and cap output; this path serves the file's exact
 * bytes over HTTP for the app's own parsing, with no representation
 * constraint. The SDK is the app's ONLY file surface — the file tools are not
 * assignable to apps.
 *
 * There is no per-app grant: an app rendered inside a chat reads that chat's
 * files as the viewing user, who can already read them on the chat surface.
 * Authorization is fail-closed at each step, in this order:
 *   1. the persistent-file store exists on this deployment
 *      (`config.skillsSandbox.enabled` — the same flag that registers the
 *      chat file tools);
 *   2. the viewer may open the app (`AppModel.findByIdForCaller`);
 *   3. the viewer may open the conversation (same rule as the chat surface);
 *   4. the file resolves within the chat's scope (the conversation's files, or
 *      the whole project's for a project chat) as the viewing user.
 */
export async function readAppConversationFile(params: {
  appId: string;
  organizationId: string;
  userId: string;
  conversationId: string;
  /** File row id (or `obj_` ref) from search_files; exactly one of id/filename. */
  id?: string;
  filename?: string;
}): Promise<{
  data: Buffer;
  mimeType: string;
  filename: string;
  fileId: string | null;
}> {
  const { appId, organizationId, userId, conversationId } = params;

  if (!config.skillsSandbox.enabled) {
    throw new ApiError(
      403,
      "Persistent files are not enabled on this deployment",
    );
  }

  const isAppAdmin = await userHasPermission(
    userId,
    organizationId,
    "app",
    "admin",
  );
  const app = await AppModel.findByIdForCaller({
    id: appId,
    organizationId,
    userId,
    isAppAdmin,
  });
  if (!app) {
    throw new ApiError(403, "Forbidden");
  }

  if (
    !(await ConversationModel.findAccessibleById({
      id: conversationId,
      userId,
      organizationId,
    }))
  ) {
    throw new ApiError(404, "Conversation not found");
  }

  const scope = await resolveProjectFileScope({
    conversationId,
    userId,
    organizationId,
  });
  const fileScope = scope
    ? ({ kind: "project", projectId: scope.projectId } as const)
    : ({ kind: "conversation", conversationId } as const);

  let resolved: Awaited<ReturnType<typeof fileStore.resolveMyFileSource>>;
  try {
    resolved = await fileStore.resolveMyFileSource({
      organizationId,
      userId,
      id: params.id,
      filename: params.filename,
      scope: fileScope,
    });
  } catch (error) {
    if (error instanceof FileBytesMissingError) {
      throw new ApiError(404, "File data is no longer available");
    }
    throw error;
  }
  if ("error" in resolved) {
    // "ambiguous" is caller-fixable (pass the id); everything else collapses
    // into 404 so probes can't distinguish missing from inaccessible.
    if (resolved.error === "ambiguous") {
      throw new ApiError(
        409,
        "More than one file matches that filename — pass its id instead",
      );
    }
    throw new ApiError(404, "File not found");
  }

  return {
    data: resolved.data,
    mimeType: resolved.mimeType,
    filename: resolved.originalName,
    fileId: resolved.fileId,
  };
}
