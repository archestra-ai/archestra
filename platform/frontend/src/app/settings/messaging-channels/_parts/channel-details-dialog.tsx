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
import { cn } from "@/lib/utils/tailwind";

type Binding =
  archestraApiTypes.ListChatOpsBindingsResponses["200"]["data"][number];

/**
 * What to call a binding on screen.
 *
 * A direct message has no channel name, so falling back to the provider's id
 * titled this dialog "19:dm000001@thread.tacv2" — and every direct message in
 * a list "Direct message", with nothing to tell two of them apart. The owner
 * is the only distinguishing thing either one has.
 */
export function channelDisplayName(binding: {
  isDm?: boolean;
  channelName?: string | null;
  channelId: string;
  dmOwnerEmail?: string | null;
}) {
  if (!binding.isDm) return binding.channelName || binding.channelId;
  return binding.dmOwnerEmail
    ? `Direct message (${binding.dmOwnerEmail})`
    : "Direct message";
}

export function ChannelDetailsDialog({
  binding,
  assignedAgent,
  open,
  readOnly,
  isSaving,
  saveLabel = "Save channel details",
  slackBot,
  onOpenChange,
  onSave,
}: {
  binding: Binding | null;
  assignedAgent: { id: string; name: string; icon?: string | null } | null;
  open: boolean;
  readOnly: boolean;
  isSaving: boolean;
  saveLabel?: string;
  /**
   * Opened from an agent's Slack bot. Several bots can share a channel, and
   * only one of them replies to every message, so the dialog speaks for this
   * bot: whether it replies to all, who does instead, and the channel's own
   * Slack description.
   */
  slackBot?: {
    handle: string;
    description: string | null;
    repliesToAll: boolean;
    /** Another agent whose bot replies to every message here. */
    repliesToAllElsewhere: string | null;
  };
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
    setAnswerAllMessages(
      slackBot ? slackBot.repliesToAll : !!binding.answerAllMessages,
    );
  }, [binding, open, slackBot]);

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
        answerAllMessages !==
          (slackBot ? slackBot.repliesToAll : !!binding.answerAllMessages)));
  const overLimit = instructions.length > CHANNEL_INSTRUCTIONS_MAX_LENGTH;
  const closeGuard = useUnsavedChangesGuard({
    isDirty: !readOnly && changed,
    onOpenChange,
  });
  if (!binding || !provider) return null;
  const channelLabel = channelDisplayName(binding);
  // A direct message is not a channel, and saying so in the one dialog that
  // configures it saves the reader working out which of the two they have.
  const noun = binding.isDm ? "direct message" : "channel";

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
            {slackBot ? (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Channel description</p>
                {slackBot.description ? (
                  <p className="whitespace-pre-wrap break-words rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm">
                    {slackBot.description}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">None yet.</p>
                )}
                <p className="text-xs text-muted-foreground">
                  Set in Slack. Bots read it to know what the channel is about.
                </p>
              </div>
            ) : (
              <dl className="grid gap-x-6 gap-y-4 border-y py-4 sm:grid-cols-2">
                <ChannelFact label={binding.isDm ? "Chat ID" : "Channel ID"}>
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
            )}

            {canEditReplyBehavior && (
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">
                      {slackBot
                        ? "Reply to all messages"
                        : "Answer all messages"}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {slackBot
                        ? "No @mention needed. Only one bot per channel can do this."
                        : "When off, this agent answers only mentions."}
                    </p>
                  </div>
                  <Switch
                    aria-label={
                      slackBot ? "Reply to all messages" : "Answer all messages"
                    }
                    checked={answerAllMessages}
                    disabled={readOnly || isSaving}
                    onCheckedChange={setAnswerAllMessages}
                  />
                </div>
                {slackBot?.repliesToAllElsewhere && answerAllMessages && (
                  <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    {slackBot.repliesToAllElsewhere} does this now. Saving
                    switches it to @{slackBot.handle}.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <SystemPromptEditor
                templating={false}
                title={
                  binding.isDm
                    ? "Conversation instructions"
                    : "Channel instructions"
                }
                value={instructions}
                onChange={setInstructions}
                readOnly={readOnly || isSaving}
                minHeight={180}
              />
              <p className="text-xs text-muted-foreground">
                {slackBot
                  ? "Every bot in this channel follows these."
                  : `These instructions take priority over the agent system prompt for messages from this ${noun}.`}
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
                permissions={{ organizationSettings: ["update"] }}
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
