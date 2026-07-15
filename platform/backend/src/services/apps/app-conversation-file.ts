import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import { AppModel, ConversationModel } from "@/models";
import { FileBytesMissingError } from "@/skills-sandbox/file-storage";
import { fileStore } from "@/skills-sandbox/file-store";
import { resolveProjectFileScope } from "@/skills-sandbox/project-file-scope";
import { ApiError, type SandboxFileListItem } from "@/types";

/**
 * Chat-scoped file access for a rendered app — the backing of the SDK's
 * `archestra.files` surface (`list` + `read`). The chat model's file tools
 * must render for an LLM, so `read_file` refuses binary and caps output; this
 * path serves file metadata and exact bytes over HTTP for the app's own use,
 * with no representation constraint. The SDK is the app's ONLY file surface —
 * the file tools are not assignable to apps.
 *
 * There is no per-app grant: an app rendered inside a chat reads that chat's
 * files as the viewing user, who can already read them on the chat surface.
 * Authorization is fail-closed at each step, in this order:
 *   1. the persistent-file store exists on this deployment
 *      (`config.skillsSandbox.enabled` — the same flag that registers the
 *      chat file tools);
 *   2. the viewer may open the app (`AppModel.findByIdForCaller`);
 *   3. the viewer may open the conversation (same rule as the chat surface);
 *   4. files resolve within the chat's scope (the conversation's files, or the
 *      whole project's for a project chat) as the viewing user.
 */

/** List the chat-scoped files the app may read (optionally filename-filtered). */
export async function listAppConversationFiles(params: {
  appId: string;
  organizationId: string;
  userId: string;
  conversationId: string;
  /** Case-insensitive filename substring; omit to list. */
  query?: string;
}): Promise<SandboxFileListItem[]> {
  const fileScope = await gateAppFileAccess(params);
  return await fileStore.search({
    organizationId: params.organizationId,
    userId: params.userId,
    scope:
      fileScope.kind === "project"
        ? { ...fileScope, projectName: null }
        : fileScope,
    query: params.query,
  });
}

/** Raw bytes of one chat-scoped file, identified by id/ref or filename. */
export async function readAppConversationFile(params: {
  appId: string;
  organizationId: string;
  userId: string;
  conversationId: string;
  /** File row id (or `obj_` ref) from the listing; exactly one of id/filename. */
  id?: string;
  filename?: string;
}): Promise<{
  data: Buffer;
  mimeType: string;
  filename: string;
  fileId: string | null;
}> {
  const fileScope = await gateAppFileAccess(params);

  let resolved: Awaited<ReturnType<typeof fileStore.resolveMyFileSource>>;
  try {
    resolved = await fileStore.resolveMyFileSource({
      organizationId: params.organizationId,
      userId: params.userId,
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

// === internal helpers ===

/** The shared gate (steps 1–3 above); resolves the chat's file scope (step 4). */
async function gateAppFileAccess(params: {
  appId: string;
  organizationId: string;
  userId: string;
  conversationId: string;
}): Promise<
  | { kind: "project"; projectId: string }
  | { kind: "conversation"; conversationId: string }
> {
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
  return scope
    ? { kind: "project", projectId: scope.projectId }
    : { kind: "conversation", conversationId };
}
