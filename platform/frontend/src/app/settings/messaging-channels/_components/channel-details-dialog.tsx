"use client";

import {
  type archestraApiTypes,
  CHANNEL_INSTRUCTIONS_MAX_LENGTH,
  MESSAGING_CHANNEL_LABELS,
} from "@archestra/shared";
import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { ChannelIcon } from "@/components/channel-icon";
import { SystemPromptEditor } from "@/components/system-prompt-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import { Switch } from "@/components/ui/switch";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { cn } from "@/lib/utils";

type Binding =
  archestraApiTypes.ListChatOpsBindingsResponses["200"]["data"][number];

export function ChannelDetailsDialog({
  binding,
  assignedAgent,
  open,
  readOnly,
  isSaving,
  saveLabel = "Save channel details",
  onOpenChange,
  onSave,
}: {
  binding: Binding | null;
  assignedAgent: { id: string; name: string; icon?: string | null } | null;
  open: boolean;
  readOnly: boolean;
  isSaving: boolean;
  saveLabel?: string;
  onOpenChange: (open: boolean) => void;
  onSave: (values: {
    channelInstructions: string | null;
    answerAllMessages: boolean;
  }) => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [answerAllMessages, setAnswerAllMessages] = useState(false);
  const initializedBindingIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      initializedBindingIdRef.current = null;
      return;
    }
    if (!binding || initializedBindingIdRef.current === binding.id) return;
    initializedBindingIdRef.current = binding.id;
    setInstructions(binding.channelInstructions ?? "");
    setAnswerAllMessages(!!binding.answerAllMessages);
  }, [binding, open]);

  const provider = binding?.provider as
    | "ms-teams"
    | "slack"
    | "telegram"
    | undefined;
  const canEditReplyBehavior =
    !!binding && !binding.isDm && provider !== "telegram";
  const changed =
    !!binding &&
    ((instructions.trim() || null) !== (binding.channelInstructions ?? null) ||
      (canEditReplyBehavior &&
        answerAllMessages !== !!binding.answerAllMessages));
  const overLimit = instructions.length > CHANNEL_INSTRUCTIONS_MAX_LENGTH;
  const closeGuard = useUnsavedChangesGuard({
    isDirty: !readOnly && changed,
    onOpenChange,
  });
  if (!binding || !provider) return null;
  const channelLabel = binding.channelName || binding.channelId;

  return (
    <>
      <Dialog open={open} onOpenChange={closeGuard.handleOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <div className="flex min-w-0 items-start gap-2.5 text-left">
              <ChannelIcon
                channel={provider}
                className="mt-0.5 size-5 shrink-0"
              />
              <div className="min-w-0">
                <DialogTitle className="break-words">
                  {channelLabel}
                </DialogTitle>
                <DialogDescription>
                  {MESSAGING_CHANNEL_LABELS[provider]}
                  {binding.workspaceName ? ` · ${binding.workspaceName}` : ""}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <DialogBody className="space-y-5">
            <dl className="grid gap-x-6 gap-y-4 border-y py-4 sm:grid-cols-2">
              <ChannelFact label="Channel ID">
                <code className="break-all text-xs">{binding.channelId}</code>
              </ChannelFact>
              <ChannelFact label="Assigned agent">
                {assignedAgent ? (
                  <Link
                    href={`/agents/${assignedAgent.id}`}
                    className="inline-flex min-w-0 items-center gap-1.5 font-medium hover:underline"
                  >
                    <AgentIcon icon={assignedAgent.icon} size={16} />
                    <span className="truncate">{assignedAgent.name}</span>
                  </Link>
                ) : (
                  <span>None</span>
                )}
              </ChannelFact>
            </dl>

            {canEditReplyBehavior && (
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">Answer all messages</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    When off, this agent answers only mentions.
                  </p>
                </div>
                <Switch
                  aria-label="Answer all messages"
                  checked={answerAllMessages}
                  disabled={readOnly || isSaving}
                  onCheckedChange={setAnswerAllMessages}
                />
              </div>
            )}

            <div className="space-y-2">
              <SystemPromptEditor
                title="Channel instructions"
                value={instructions}
                onChange={setInstructions}
                readOnly={readOnly || isSaving}
                height="180px"
              />
              <p className="text-xs text-muted-foreground">
                These instructions take priority over the agent system prompt
                for messages from this channel.
              </p>
              <p
                className={cn(
                  "text-right text-xs tabular-nums",
                  overLimit ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {instructions.length} / {CHANNEL_INSTRUCTIONS_MAX_LENGTH}
              </p>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={closeGuard.requestClose}
            >
              <span>{readOnly ? "Close" : "Cancel"}</span>
            </Button>
            {!readOnly && (
              <PermissionButton
                type="button"
                permissions={{ agentTrigger: ["update"] }}
                disabled={!changed || overLimit || isSaving}
                onClick={() =>
                  onSave({
                    channelInstructions: instructions.trim() || null,
                    answerAllMessages,
                  })
                }
              >
                <span>{isSaving ? "Saving..." : saveLabel}</span>
              </PermissionButton>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UnsavedChangesDialog
        open={closeGuard.confirmOpen}
        onKeepEditing={closeGuard.keepEditing}
        onDiscard={closeGuard.discardChanges}
      />
    </>
  );
}

function ChannelFact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}
