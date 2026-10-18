"use client";

import type { UIMessage } from "@ai-sdk/react";
import {
  Download,
  Pencil,
  Pin,
  PinOff,
  Share2,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { type ComponentProps, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { appInteractive } from "@/lib/app-interactive";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  fetchConversation,
  useDeleteConversation,
  useGenerateConversationTitle,
  usePinConversation,
  useUpdateConversation,
} from "@/lib/chat/chat.query";
import { isActionAvailableForConversation } from "@/lib/chat/encrypted-chat";
import { downloadConversationMarkdown } from "@/lib/chat/export-markdown";
import { useGlobalChat } from "@/lib/chat/global-chat.context";
import { canCreateProjectFromChat } from "@/lib/projects/can-create-project-from-chat";
import {
  useCreateProject,
  useCreateProjectFromConversation,
} from "@/lib/projects/projects.query";
import { lazyComponent } from "@/lib/utils/preloadable-lazy";

// The project picker (a command list) and the share dialog (resource
// permissions) open from the actions menu; their code loads on idle and when
// they open, not with the conversation page.
const ConversationProjectActions = lazyComponent<
  ComponentProps<
    typeof import("@/app/_parts/conversation-project-actions").ConversationProjectActions
  >
>(() =>
  import("@/app/_parts/conversation-project-actions").then(
    (m) => m.ConversationProjectActions,
  ),
);
const ShareConversationDialog = lazyComponent<
  ComponentProps<
    typeof import("@/components/chat/share-conversation-dialog").ShareConversationDialog
  >
>(() =>
  import("@/components/chat/share-conversation-dialog").then(
    (m) => m.ShareConversationDialog,
  ),
);
/** Fetch the menu's lazy parts ahead of need (done on idle). */
export async function preloadConversationActionParts(): Promise<void> {
  await Promise.all([
    ConversationProjectActions.preload(),
    ShareConversationDialog.preload(),
  ]);
}

if (typeof window !== "undefined") {
  void appInteractive.whenIdle().then(preloadConversationActionParts);
}

/**
 * The actions for one chat: the same list in the sidebar row menu and in the
 * chat header menu. Render `items` inside a DropdownMenuContent and `dialogs`
 * outside it, because the menu unmounts its content when it closes.
 */
export function useConversationActions({
  conversation,
  canShare,
  isShared = false,
  appIds,
  onRename,
}: {
  conversation: ActionConversation | null | undefined;
  /** Overrides the owner-only default, e.g. for a scoped manage grant. */
  canShare?: boolean;
  isShared?: boolean;
  /** Apps owned by the chat, listed in the share dialog. */
  appIds?: string[];
  /** Inline rename in place of the rename dialog. */
  onRename?: () => void;
}): { items: ReactNode; dialogs: ReactNode } {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const { markTitleAnimating } = useGlobalChat();
  const { data: canUpdate } = useHasPermissions({ chat: ["update"] });
  const { data: canDelete } = useHasPermissions({ chat: ["delete"] });
  const { data: canReadProjects } = useHasPermissions({ project: ["read"] });
  const { data: canCreateProject } = useHasPermissions({
    project: ["create"],
  });
  const updateMutation = useUpdateConversation();
  const pinMutation = usePinConversation();
  const generateTitleMutation = useGenerateConversationTitle();
  const deleteMutation = useDeleteConversation();
  const createProjectMutation = useCreateProject();
  const createFromChatMutation = useCreateProjectFromConversation();

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  // Mounted from its first open on, so closing still animates.
  const [shareOpened, setShareOpened] = useState(false);
  if (shareOpen && !shareOpened) setShareOpened(true);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (!conversation) {
    return { items: null, dialogs: null };
  }

  const id = conversation.id;
  // Pin, rename, move and delete act on the viewer's own chat; a shared or
  // overseen chat only offers export.
  const isOwner = conversation.userId === session?.user.id;
  const mayUpdate = isOwner && canUpdate === true;
  const mayDelete = isOwner && canDelete === true;
  const mayShare =
    (canShare ?? isOwner) &&
    isActionAvailableForConversation(conversation, "share");
  const mayRegenerateTitle =
    mayUpdate &&
    isActionAvailableForConversation(conversation, "generateTitle");
  const mayChangeProject =
    mayUpdate &&
    canReadProjects === true &&
    isActionAvailableForConversation(conversation, "changeProject");
  const isPinned = !!conversation.pinnedAt;

  const changeProject = async (projectId: string | null) => {
    try {
      await updateMutation.mutateAsync({ id, projectId });
    } catch {
      // Error is handled by the mutation's onError callback.
    }
  };

  const exportMarkdown = async () => {
    const data = await fetchConversation(id);
    const messages = (data?.messages ?? []) as UIMessage[];
    if (messages.length === 0) {
      toast.info("This chat has no messages to export yet.");
      return;
    }
    downloadConversationMarkdown({
      messages,
      conversationId: id,
      title: data?.title,
      agentName: data?.agent?.name,
    });
  };

  const saveRename = async () => {
    const title = renameValue.trim();
    if (!title) return;
    try {
      await updateMutation.mutateAsync({ id, title });
      setRenameOpen(false);
    } catch {
      // Error is handled by the mutation's onError callback.
    }
  };

  const items = (
    <>
      {mayUpdate && (
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            pinMutation.mutate({ id, pinned: !isPinned });
          }}
        >
          {isPinned ? <PinOff /> : <Pin />}
          <span>{isPinned ? "Unpin" : "Pin"}</span>
        </DropdownMenuItem>
      )}
      {mayUpdate && (
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            if (onRename) {
              onRename();
            } else {
              setRenameValue(conversation.title ?? "");
              setRenameOpen(true);
            }
          }}
        >
          <Pencil />
          Rename
        </DropdownMenuItem>
      )}
      {mayRegenerateTitle && (
        <DropdownMenuItem
          disabled={generateTitleMutation.isPending}
          onClick={(e) => {
            e.stopPropagation();
            generateTitleMutation.mutate(
              { id, regenerate: true },
              { onSuccess: (data) => data && markTitleAnimating(id) },
            );
          }}
        >
          <Sparkles />
          Regenerate title
        </DropdownMenuItem>
      )}
      {mayChangeProject && (
        <ConversationProjectActions
          projectId={conversation.projectId}
          isPending={
            updateMutation.isPending ||
            createProjectMutation.isPending ||
            createFromChatMutation.isPending
          }
          onProjectChange={changeProject}
          onCreateProject={
            canCreateProject !== true
              ? undefined
              : canCreateProjectFromChat({
                    hasCreatePermission: true,
                    conversation,
                  })
                ? // Also carries the chat's files into the new project.
                  async (name) => {
                    await createFromChatMutation.mutateAsync({
                      conversationId: id,
                      name,
                    });
                  }
                : async (name) => {
                    const project = await createProjectMutation.mutateAsync({
                      name,
                    });
                    if (project) await changeProject(project.id);
                  }
          }
        />
      )}
      {mayShare && (
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            setShareOpen(true);
          }}
        >
          {isShared ? <Users className="text-primary" /> : <Share2 />}
          {isShared ? (
            <span className="text-primary">Shared</span>
          ) : (
            <span>Share</span>
          )}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={(e) => {
          e.stopPropagation();
          void exportMarkdown();
        }}
      >
        <Download />
        Export Markdown
      </DropdownMenuItem>
      {mayDelete && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              setDeleteOpen(true);
            }}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="text-destructive" />
            Delete
          </DropdownMenuItem>
        </>
      )}
    </>
  );

  const dialogs = (
    <>
      {mayShare && shareOpened && (
        <ShareConversationDialog
          conversationId={id}
          appIds={appIds}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
      <StandardDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename chat"
        size="small"
        bodyClassName="py-1"
        footer={
          <>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={saveRename}
              disabled={!renameValue.trim() || updateMutation.isPending}
            >
              Save
            </Button>
          </>
        }
      >
        <Input
          aria-label="Chat title"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void saveRename();
          }}
          autoFocus
        />
      </StandardDialog>
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete conversation?"
        description="This action cannot be undone. This will permanently delete the conversation and all its messages."
        isPending={deleteMutation.isPending}
        onConfirm={async () => {
          // Leave the chat first so it never flashes "not found".
          if (pathname === `/chat/${id}`) router.push("/chat");
          try {
            await deleteMutation.mutateAsync(id);
            setDeleteOpen(false);
          } catch {
            // Error is handled by the mutation's onError callback.
          }
        }}
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />
    </>
  );

  return { items, dialogs };
}

// === Internal ===

interface ActionConversation {
  id: string;
  title: string | null;
  userId: string;
  pinnedAt: string | null;
  projectId: string | null;
  encryptedChat?: boolean;
  origin: string;
}
