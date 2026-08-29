"use client";

import {
  type ChatExternalMcpSkillMetadata,
  type ChatSkillMetadata,
  type ContextWindowBreakdown,
  chatUploadRejectionReason,
  DEFAULT_CHAT_ATTACHMENT_STORAGE_BYTES,
  E2eTestId,
  getMediaType,
  getModelReadableMimeTypes,
  INLINE_TEXT_MAX_BYTES,
  type ModelInputModality,
  parseSandboxCommand,
} from "@archestra/shared";
import type { ChatStatus } from "ai";
import { TerminalSquare, XIcon } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { LockedChatIcon } from "@/components/chat/locked-chat-icon";
import { PlaywrightInstallInline } from "@/components/chat/playwright-install-dialog";
import { SensitiveDataConfirmDialog } from "@/components/chat/sensitive-data-confirm-dialog";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfile } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useConversation, useToggleHooksDebug } from "@/lib/chat/chat.query";
import {
  chatMessageQueue,
  useConversationMessageQueue,
} from "@/lib/chat/chat-message-queue";
import { useChatPlaceholder } from "@/lib/chat/chat-placeholder.hook";
import {
  chatDraftStorageKey,
  migrateLegacyNewChatDraft,
} from "@/lib/chat/chat-utils";
import { isActionAvailableForConversation } from "@/lib/chat/locked-chat";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useToolbarCollapse } from "@/lib/hooks/use-toolbar-collapse";
import { useOrganization } from "@/lib/organization.query";
import { scanText } from "@/lib/sensitive-data";
import { useSkillsPaginated } from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils";
import {
  ChatPromptInputTools,
  type ChatPromptInputToolsProps,
} from "./prompt-input-tools";
import {
  buildSkillCommands,
  DEBUG_COMMAND_VALUE,
  isDebugCommand,
  parseExternalMcpSkillCommand,
  parseSkillCommand,
  type SkillCommand,
} from "./skill-commands";

// Fallback sandbox artifact limit when /api/config has not loaded yet (mirrors
// the backend default, which tracks the chat attachment storage cap). Only
// consulted when a sandbox is available.
const DEFAULT_SANDBOX_ARTIFACT_BYTES = DEFAULT_CHAT_ATTACHMENT_STORAGE_BYTES;

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * The largest file the conversation can store, as configured by the server.
 * Both the file picker's hard cap and the per-file policy read this one value,
 * so the composer can never advertise a size it then refuses.
 */
function useChatAttachmentStorageByteLimit(): number {
  return (
    useFeature("chatAttachmentStorageBytesLimit") ??
    DEFAULT_CHAT_ATTACHMENT_STORAGE_BYTES
  );
}

// Fallback request body ceiling before /api/config resolves (mirrors the
// backend default). Leaves room for the message text, history refs, and the
// JSON envelope that ride alongside the attachments in the same request.
const DEFAULT_API_BODY_LIMIT_BYTES = 70 * 1024 * 1024;
const TURN_BODY_RESERVE_BYTES = 2 * 1024 * 1024;

/**
 * How many base64 attachment characters one turn may carry. A single file is
 * bounded by the storage cap, but nothing bounds their sum — and every
 * attachment of a turn travels base64-encoded in one request, so two
 * within-cap files can still overrun the body parser. It rejects the request
 * before any handler runs, so the composer has to catch this itself or the
 * user gets an opaque 413.
 */
function useTurnAttachmentBudget(): number {
  const bodyLimit =
    useFeature("apiBodyLimitBytes") ?? DEFAULT_API_BODY_LIMIT_BYTES;
  return Math.max(0, bodyLimit - TURN_BODY_RESERVE_BYTES);
}

/**
 * Serialized size of a turn's attachments. By submit time each file's `url` is
 * already the base64 `data:` URL that goes on the wire, so its length is the
 * exact cost — no encoding estimate needed.
 */
function attachmentPayloadBytes(files: readonly { url?: string }[]): number {
  return files.reduce((total, file) => total + (file.url?.length ?? 0), 0);
}

/**
 * Options riding alongside a submitted message. At most one is set: a `/`
 * slash command activates a skill, a `!` prefix marks the message for direct
 * sandbox execution (the marker lands in `metadata.sandboxCommand`).
 */
export type ChatSubmitOptions = {
  skill?: ChatSkillMetadata;
  externalMcpSkill?: ChatExternalMcpSkillMetadata;
  sandboxCommand?: true;
};

export interface ArchestraPromptInputProps
  extends Omit<
    ChatPromptInputToolsProps,
    "textareaRef" | "isNarrow" | "toolbarRef"
  > {
  /**
   * Handle a submit. The textarea and the saved draft are cleared only when
   * this resolves/returns without throwing. Throw (or reject) to reject the
   * submit and keep both the typed text and its draft.
   */
  onSubmit: (
    message: PromptInputMessage,
    e: FormEvent<HTMLFormElement>,
    options?: ChatSubmitOptions,
  ) => void | Promise<void>;
  /**
   * Stop the in-flight response. When set, the submit button acts as a Stop
   * button while a response is streaming (a click stops instead of
   * submitting), so submits during a stream only come from Enter — which
   * onSubmit queues rather than sends.
   */
  onStop?: () => void;
  status: ChatStatus;
  // Tools integration props
  /**
   * Null while the new-chat screen is still resolving which agent this chat
   * starts on. The composer renders its chrome regardless — a toolbar that
   * fills in reads better than a spinner where the page should be — and submit
   * is held disabled by the caller until it resolves.
   */
  agentId: string | null;
  /**
   * Input modalities supported by the selected model. Only used to mirror the
   * backend ingest policy in validateFile — the composer accepts any file type
   * (a file the model can't read lands in the conversation's Files panel).
   */
  inputModalities?: ModelInputModality[] | null;
  // Ref for autofocus
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Per-category breakdown of the assembled request (for context usage panel) */
  contextWindow?: ContextWindowBreakdown | null;
  /** Most recent compaction result, surfaced as a marker in the context panel */
  lastCompaction?: {
    originalTokenEstimate?: number;
    compactedTokenEstimate?: number;
    trigger?: "auto" | "manual";
  } | null;
  /** Disable the submit button (e.g., when Playwright setup overlay is visible) */
  submitDisabled?: boolean;
  /**
   * Disable sending while leaving the composer typeable. `submitDisabled`
   * locks the whole thing, which is right when the composer must not be used
   * at all; this is for the narrower case where the draft is welcome but has
   * nowhere to go yet — the new-chat screen before its agent has resolved.
   */
  sendDisabled?: boolean;
  /** Disable chat input while context compaction is running */
  isContextCompacting?: boolean;
  /** Manually compact the active conversation */
  onCompactConversation?: () => Promise<void> | void;
  /**
   * The current user is known to need a browser instance before this agent's
   * tools can run. It replaces the message input with the install card, so it
   * must mean *known*, never "still checking" — a check that is merely in
   * flight has to leave the input alone (see `sendDisabled` for that state).
   */
  isPlaywrightSetupRequired: boolean;
  /**
   * One-shot composer prefill (e.g. a skill slash command from a deep link).
   * Applied to the controller-owned input, then acknowledged via
   * onPrefillApplied so the owner can clear it and it is never re-applied.
   */
  prefillText?: string | null;
  onPrefillApplied?: () => void;
  externalMcpSkillAttachment?: ChatExternalMcpSkillMetadata | null;
  onRemoveExternalMcpSkillAttachment?: () => void;
  onRestoreExternalMcpSkillAttachment?: (
    skill: ChatExternalMcpSkillMetadata,
  ) => void;
  /** Render the new-chat composer as an isolated execution launcher. */
  executionMode?: boolean;
  executionAgentName?: string;
}

type SlashCommand = {
  value: string;
  name: string;
  description: string;
  /** Set for skill commands; absent for built-in commands like /compact. */
  skill?: ChatSkillMetadata;
};

const COMPACT_COMMAND: SlashCommand = {
  value: "/compact",
  name: "compact",
  description: "summarize conversation to prevent hitting the context limit",
};

// Inner component that has access to the controller context
const PromptInputContent = ({
  onSubmit,
  onStop,
  status,
  selectedModel,
  onModelChange,
  agentId,
  conversationId,
  currentConversationChatApiKeyId,
  currentProvider,
  initialApiKeyId,
  onApiKeyChange,
  onProviderChange,
  textareaRef: externalTextareaRef,
  allowFileUploads = false,
  isModelsLoading = false,
  tokensUsed = 0,
  cachedTokens,
  maxContextLength,
  contextWindow,
  lastCompaction,
  agentLlmApiKeyId,
  submitDisabled = false,
  sendDisabled = false,
  subscriptionConnectRequired = false,
  isContextCompacting = false,
  onCompactConversation,
  isPlaywrightSetupRequired = false,
  selectorAgentId,
  onAgentChange,
  modelSource,
  toolsUnavailable,
  notRecommendedForAgents,
  onResetModelOverride,
  thinkingEffort,
  onThinkingEffortChange,
  agentRequiresPerUserConnect,
  agentModelDisplayName,
  subscriptionProvider,
  sandboxAvailable,
  lockedChat = false,
  onLockedChatChange,
  prefillText,
  onPrefillApplied,
  externalMcpSkillAttachment,
  onRemoveExternalMcpSkillAttachment,
  onRestoreExternalMcpSkillAttachment,
  executionMode = false,
  executionAgentName,
}: Omit<ArchestraPromptInputProps, "onSubmit"> & {
  onSubmit: ArchestraPromptInputProps["onSubmit"];
  sandboxAvailable: boolean;
}) => {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalTextareaRef ?? internalTextareaRef;
  const controller = usePromptInputController();
  const storageByteLimit = useChatAttachmentStorageByteLimit();
  const turnAttachmentBudget = useTurnAttachmentBudget();
  const [subscriptionConnectRequest, setSubscriptionConnectRequest] =
    useState(0);
  const requestSubscriptionConnect = useCallback(() => {
    setSubscriptionConnectRequest((request) => request + 1);
  }, []);

  // Collapse the toolbar based on whether its inline controls actually fit —
  // measured on the footer, not the viewport — so it reacts when the right-side
  // panel squeezes the input while the window stays wide, and only collapses
  // when the controls genuinely no longer fit.
  const footerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const isNarrow = useToolbarCollapse({
    availableRef: footerRef,
    contentRef: toolbarRef,
    trailingRef,
  });

  const commandItemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [dismissedSlashCommandValue, setDismissedSlashCommandValue] = useState<
    string | null
  >(null);

  // /debug needs the conversation below; fetched early so the locked-chat gate
  // can read it too.
  const { data: conversation } = useConversation(conversationId);

  // LockedChat is "active" for the composer both while chatting in a locked
  // chat and while the new-chat toggle is on. It drives the composer's own
  // dressing (the notice strip and dashed border) and hides the affordances
  // the backend still rejects — sandbox `!` commands. Uploads are NOT among
  // them any more: a locked chat's attachments are sealed under its key.
  const lockedChatActive =
    !isActionAvailableForConversation(conversation, "sandboxCommands") ||
    (lockedChat && !conversationId);
  const appName = useAppName();

  // Any file type can be attached regardless of model modalities or sandbox:
  // a file the model can't read is still stored and surfaced in the
  // conversation's Files panel (and staged into the sandbox when one is
  // available), so uploads are gated only by the org-level toggle (and the
  // locked-chat block) and the OS picker is unrestricted.
  const showFileUploadButton = allowFileUploads;

  // Chat placeholders from organization settings
  const { data: orgData } = useOrganization();
  const { placeholder: chatPlaceholder } = useChatPlaceholder({
    animate: orgData?.animateChatPlaceholders ?? true,
    placeholders: orgData?.chatPlaceholders,
  });

  // Skills exposed as slash commands whenever the org's skill tools are on —
  // the same flag that gates the backend's activation injection.
  const skillSlashCommandsEnabled = orgData?.skillToolsEnabled ?? false;
  // Scoped to the conversation agent's environment: a slash command must not
  // offer a skill the backend's activation gate would refuse.
  const { data: skillsData } = useSkillsPaginated(
    { limit: 100, forAgentId: agentId ?? undefined },
    { enabled: skillSlashCommandsEnabled && !!agentId },
  );
  const skillCommands = useMemo<SkillCommand[]>(() => {
    if (!skillSlashCommandsEnabled || !skillsData?.data) {
      return [];
    }
    return buildSkillCommands(
      skillsData.data,
      externalMcpSkillAttachment
        ? [externalMcpSkillAttachment.commandValue]
        : [],
    );
  }, [externalMcpSkillAttachment, skillSlashCommandsEnabled, skillsData]);

  // /debug toggles per-conversation hook debug chips; admin-only, existing
  // conversation only. Mirrors the server gate (agent-type admin) loosely — the
  // toggle endpoint enforces it for real.
  const { data: isAgentAdmin } = useHasPermissions({ agent: ["admin"] });
  const toggleHooksDebug = useToggleHooksDebug();
  const agentHooksEnabled = useFeature("agentHooksEnabled") ?? false;
  const hooksDebugEnabled = conversation?.hooksDebugEnabled ?? false;
  const canDebug = Boolean(conversationId && isAgentAdmin && agentHooksEnabled);

  // Compaction needs a persisted conversation to summarize, so both of its
  // entry points — /compact and the context window panel's action — share this
  // gate.
  const compactConversation =
    conversationId && onCompactConversation ? onCompactConversation : undefined;

  // /compact and /debug apply to an existing conversation; skill commands work anywhere.
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const compact = compactConversation ? [COMPACT_COMMAND] : [];
    const debug: SlashCommand[] = canDebug
      ? [
          {
            value: DEBUG_COMMAND_VALUE,
            name: "debug",
            description: hooksDebugEnabled
              ? "hide inline hook debug chips"
              : "show inline hook debug chips",
          },
        ]
      : [];
    return [...compact, ...debug, ...skillCommands];
  }, [compactConversation, canDebug, hooksDebugEnabled, skillCommands]);

  // Keyed by conversation only — NOT by agentId. Keying the new-chat draft by
  // agent made the restore effect below re-run on every agent switch and clear
  // the input, dropping the user's in-progress prompt.
  const storageKey = chatDraftStorageKey(conversationId);

  const isRestored = useRef(false);

  // One-time migration of pre-upgrade per-agent new-chat drafts to the shared
  // key, so an unsent draft written before this change is not dropped. Runs
  // before the restore effect below so the restore reads the migrated value.
  useEffect(() => {
    migrateLegacyNewChatDraft(localStorage);
  }, []);

  // Restore draft on mount or conversation change
  useEffect(() => {
    isRestored.current = false;
    const savedDraft = localStorage.getItem(storageKey);
    if (savedDraft) {
      controller.textInput.setInput(savedDraft);
    } else {
      controller.textInput.setInput("");
    }

    // Set restored bit after a tick to ensure state update propagates
    const timeout = setTimeout(() => {
      isRestored.current = true;
    }, 0);
    return () => clearTimeout(timeout);
  }, [storageKey, controller.textInput.setInput]);

  // Save draft on change
  useEffect(() => {
    if (!isRestored.current) return;

    const value = controller.textInput.value;
    if (value) {
      localStorage.setItem(storageKey, value);
    } else {
      localStorage.removeItem(storageKey);
    }
  }, [controller.textInput.value, storageKey]);

  // Apply a one-shot prefill from the page (e.g. a skill deep link). The
  // controller stays the single owner of the input value — the page hands the
  // text over once and clears its request via onPrefillApplied, so editing or
  // deleting the text afterwards behaves exactly like typed input.
  useEffect(() => {
    if (prefillText == null) return;
    controller.textInput.setInput(prefillText);
    onPrefillApplied?.();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [
    prefillText,
    onPrefillApplied,
    controller.textInput.setInput,
    textareaRef,
  ]);

  // Handle speech transcription by updating controller state
  const handleTranscriptionChange = useCallback(
    (text: string) => {
      controller.textInput.setInput(text);
    },
    [controller.textInput],
  );

  // Subtle affordance for the `!` convention: shown while the typed text
  // starts with `!` on a sandbox-equipped agent, i.e. whenever submitting
  // could run it as a sandbox command instead of sending it to the model.
  // Hidden for locked chats, where the backend rejects sandbox commands.
  const isSandboxCommandHintVisible =
    sandboxAvailable &&
    !lockedChatActive &&
    controller.textInput.value.trimStart().startsWith("!");

  // The picker stays open while the user is still typing the command token;
  // once a space is entered they have moved on to the prompt body.
  const isSlashCommandOpen =
    slashCommands.length > 0 &&
    controller.textInput.value.startsWith("/") &&
    !/\s/.test(controller.textInput.value) &&
    controller.textInput.value !== dismissedSlashCommandValue;

  // reset the Escape dismissal once the user edits the input — typing more
  // produces a new query and the picker should re-open
  useEffect(() => {
    if (
      dismissedSlashCommandValue !== null &&
      controller.textInput.value !== dismissedSlashCommandValue
    ) {
      setDismissedSlashCommandValue(null);
    }
  }, [controller.textInput.value, dismissedSlashCommandValue]);
  const visibleSlashCommands = useMemo(() => {
    if (!isSlashCommandOpen) {
      return [];
    }

    const query = controller.textInput.value.trim().toLowerCase();
    if (query === "/") {
      return slashCommands;
    }

    return slashCommands.filter((command) => command.value.startsWith(query));
  }, [controller.textInput.value, isSlashCommandOpen, slashCommands]);

  const selectedCommandIndex =
    visibleSlashCommands.length === 0
      ? 0
      : Math.max(
          0,
          Math.min(activeCommandIndex, visibleSlashCommands.length - 1),
        );

  useEffect(() => {
    if (isSlashCommandOpen) {
      setActiveCommandIndex(0);
    }
  }, [isSlashCommandOpen]);

  useEffect(() => {
    commandItemRefs.current[selectedCommandIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedCommandIndex]);

  const runCompactCommand = useCallback(() => {
    controller.textInput.clear();
    localStorage.removeItem(storageKey);
    void onCompactConversation?.();
  }, [controller.textInput, onCompactConversation, storageKey]);

  const runDebugCommand = useCallback(() => {
    controller.textInput.clear();
    localStorage.removeItem(storageKey);
    if (!conversationId) return;
    toggleHooksDebug.mutate({
      id: conversationId,
      enabled: !hooksDebugEnabled,
    });
  }, [
    controller.textInput,
    storageKey,
    conversationId,
    hooksDebugEnabled,
    toggleHooksDebug,
  ]);

  const selectSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.skill) {
        // a skill command is a prefix — drop it into the input so the user can
        // type an optional prompt; submitting it bare activates the skill as-is
        controller.textInput.setInput(`${command.value} `);
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      if (command.value === "/compact") {
        runCompactCommand();
      }
      if (command.value === DEBUG_COMMAND_VALUE) {
        runDebugCommand();
      }
    },
    [controller.textInput, runCompactCommand, runDebugCommand, textareaRef],
  );

  const sensitiveDataDetectionEnabled =
    useFeature("chatSecretScanEnabled") ?? false;
  const [sensitiveDataDialogOpen, setSensitiveDataDialogOpen] = useState(false);
  const pendingSubmissionRef = useRef<{
    outgoing: PromptInputMessage;
    e: FormEvent<HTMLFormElement>;
    options?: ChatSubmitOptions;
    resolve: () => void;
    reject: (reason?: unknown) => void;
  } | null>(null);

  // The draft is cleared only once the consumer accepts the submit (a
  // non-throwing, non-rejecting return). A rejecting consumer (e.g. the
  // new-chat composer refusing a text+attachment submit) keeps the draft and,
  // because the throw/rejection propagates, ai-elements also keeps the textarea
  // — so the typed prompt survives. Mirrors the textarea-clear timing.
  const dispatchSubmit = useCallback(
    (
      outgoing: PromptInputMessage,
      e: FormEvent<HTMLFormElement>,
      options?: ChatSubmitOptions,
    ): void | Promise<void> => {
      const result = onSubmit(outgoing, e, options);
      if (result instanceof Promise) {
        return result.then(() => {
          localStorage.removeItem(storageKey);
          onRemoveExternalMcpSkillAttachment?.();
        });
      }
      localStorage.removeItem(storageKey);
      onRemoveExternalMcpSkillAttachment?.();
    },
    [onRemoveExternalMcpSkillAttachment, onSubmit, storageKey],
  );

  const handleWrappedSubmit = useCallback(
    (message: PromptInputMessage, e: FormEvent<HTMLFormElement>) => {
      if (subscriptionConnectRequired) {
        e.preventDefault();
        return;
      }

      // Each file passed the per-file cap on its own, but they all ride in one
      // request. Stop here rather than letting the body parser 413 the send.
      const payloadBytes = attachmentPayloadBytes(message.files);
      if (payloadBytes > turnAttachmentBudget) {
        e.preventDefault();
        toast.error(
          `These attachments total ${formatBytes(payloadBytes)}, over the ${formatBytes(turnAttachmentBudget)} limit for one message. Send them in separate messages.`,
        );
        return;
      }

      const trimmed = message.text.trim();

      if (trimmed === "/compact" && onCompactConversation) {
        e.preventDefault();
        runCompactCommand();
        return;
      }

      if (isDebugCommand(trimmed) && canDebug) {
        e.preventDefault();
        runDebugCommand();
        return;
      }

      // a `!`-prefixed message runs directly in the conversation's sandbox —
      // disjoint from the `/`-commands above and the skill commands below,
      // since those require a `/` prefix. The text is sent exactly as typed;
      // only a metadata marker rides along. Locked chats never mark the
      // message (the backend rejects sandbox commands there), so a leading
      // `!` goes to the model as ordinary text.
      const isSandboxCommand =
        sandboxAvailable &&
        !lockedChatActive &&
        parseSandboxCommand(trimmed) !== null;

      // a skill command activates the skill; any text after the token is an
      // optional prompt — a bare skill command sends with an empty prompt
      let outgoing = message;
      const parsedExternalSkill =
        !isSandboxCommand && externalMcpSkillAttachment
          ? parseExternalMcpSkillCommand({
              text: trimmed,
              skill: externalMcpSkillAttachment,
            })
          : null;
      if (parsedExternalSkill) {
        outgoing = { ...message, text: parsedExternalSkill.remaining };
      }
      let skill: ChatSkillMetadata | undefined;
      const parsed = parsedExternalSkill
        ? null
        : parseSkillCommand(trimmed, skillCommands);
      if (parsed) {
        skill = parsed.skill;
        outgoing = { ...message, text: parsed.remaining };
      }

      const options: ChatSubmitOptions | undefined = isSandboxCommand
        ? { sandboxCommand: true }
        : parsedExternalSkill
          ? { externalMcpSkill: parsedExternalSkill.skill }
          : skill
            ? { skill }
            : undefined;

      if (sensitiveDataDetectionEnabled && outgoing.text.length > 0) {
        const findings = scanText(outgoing.text);
        if (findings.length > 0) {
          if (pendingSubmissionRef.current !== null)
            return new Promise<void>(() => {});
          return new Promise<void>((resolve, reject) => {
            pendingSubmissionRef.current = {
              outgoing,
              e,
              options,
              resolve,
              reject,
            };
            setSensitiveDataDialogOpen(true);
          });
        }
      }

      return dispatchSubmit(outgoing, e, options);
    },
    [
      canDebug,
      dispatchSubmit,
      lockedChatActive,
      onCompactConversation,
      runCompactCommand,
      runDebugCommand,
      sandboxAvailable,
      sensitiveDataDetectionEnabled,
      skillCommands,
      subscriptionConnectRequired,
      turnAttachmentBudget,
      externalMcpSkillAttachment,
    ],
  );

  const handleSensitiveDataConfirm = useCallback(() => {
    const pending = pendingSubmissionRef.current;
    pendingSubmissionRef.current = null;
    setSensitiveDataDialogOpen(false);
    if (!pending) return;
    try {
      const result = dispatchSubmit(
        pending.outgoing,
        pending.e,
        pending.options,
      );
      if (result instanceof Promise) {
        result.then(pending.resolve, pending.reject);
      } else {
        pending.resolve();
      }
    } catch (err) {
      pending.reject(err);
    }
  }, [dispatchSubmit]);

  const handleSensitiveDataCancel = useCallback(() => {
    const pending = pendingSubmissionRef.current;
    pendingSubmissionRef.current = null;
    setSensitiveDataDialogOpen(false);
    pending?.reject();
  }, []);

  const handleFileError = useCallback(
    (err: {
      code: "max_files" | "max_file_size" | "accept";
      message: string;
    }) => {
      if (err.code === "accept") {
        // Only reachable when uploads are disabled entirely (the composer sets
        // no accept filter otherwise — any file type is attachable).
        toast.error("File uploads are disabled");
      } else if (err.code === "max_file_size") {
        toast.error(
          `File is too large. Maximum size is ${formatBytes(storageByteLimit)}.`,
        );
      } else if (err.code === "max_files") {
        toast.error("Too many files attached.");
      }
    },
    [storageByteLimit],
  );

  const isResponseInFlight = status === "submitted" || status === "streaming";
  // Mid-stream a submit queues the message instead of sending it (see
  // classifyChatSubmitAction), but only when there is something queueable: a
  // conversation to queue into and typed text. Attachments cannot be queued
  // (the page rejects them with a toast), so staged files keep the Stop face
  // rather than promising a queue that would fail.
  const isQueueingSubmit =
    isResponseInFlight &&
    !!conversationId &&
    controller.textInput.value.trim().length > 0 &&
    controller.attachments.files.length === 0;
  // A queueable draft puts the button back on its ordinary Send face, so what
  // Enter is about to do is visible before pressing it; left on Stop, nothing
  // said the message could be queued at all.
  const submitStatus =
    status === "error" || isQueueingSubmit ? "ready" : status;

  // Context compaction normally locks the composer, but a live conversation can
  // always absorb the message into its queue, so the composer stays usable for
  // the whole compaction: Enter enqueues (classifyChatSubmitAction routes a
  // submit during compaction to the queue) and the session-level drain holds it
  // until compaction settles. This covers both shapes — auto-compaction inside
  // a streaming turn, and a manual `/compact` that runs while the conversation
  // is otherwise idle. Without it, compaction silently swallows Enter and drops
  // keyboard focus, which reads as "queueing stopped working". Only the
  // new-chat composer (nothing to queue into) still locks.
  const canComposeDuringCompaction = !!conversationId;
  const composerLocked =
    submitDisabled || (isContextCompacting && !canComposeDuringCompaction);
  // Messages queued while a response was in-flight; sent automatically (in
  // order) by the conversation's chat session once each turn settles.
  const queuedMessages = useConversationMessageQueue(conversationId);

  // Composer keyboard shortcuts layered on top of the primitive textarea:
  //   • Esc — stop the in-flight response (mirrors the Stop button).
  //   • ArrowUp on an empty composer — pop the most recently queued message
  //     back into the input to edit / resend (like shell history recall).
  // Both defer to the slash-command menu when it is open: Esc dismisses that
  // menu and ArrowUp navigates it (handled further down).
  const handleTextareaKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key === "Escape" &&
        !isSlashCommandOpen &&
        isResponseInFlight &&
        onStop
      ) {
        event.preventDefault();
        onStop();
        return;
      }

      if (
        event.key === "ArrowUp" &&
        !isSlashCommandOpen &&
        conversationId &&
        controller.textInput.value === "" &&
        queuedMessages.length > 0
      ) {
        event.preventDefault();
        const mostRecent = queuedMessages[queuedMessages.length - 1];
        if (mostRecent) {
          chatMessageQueue.remove(conversationId, mostRecent.id);
          if (mostRecent.externalMcpSkill) {
            onRestoreExternalMcpSkillAttachment?.(mostRecent.externalMcpSkill);
          }
          const restored = [
            mostRecent.skill ? `/${mostRecent.skill.name}` : null,
            mostRecent.externalMcpSkill
              ? mostRecent.externalMcpSkill.commandValue
              : null,
            mostRecent.text,
          ]
            .filter(Boolean)
            .join(" ");
          controller.textInput.setInput(restored);
          // Caret to the end so the user can append / edit immediately.
          requestAnimationFrame(() => {
            const element = textareaRef.current;
            element?.focus();
            element?.setSelectionRange(restored.length, restored.length);
          });
        }
        return;
      }

      if (!isSlashCommandOpen || visibleSlashCommands.length === 0) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveCommandIndex(
          (current) => (current + 1) % visibleSlashCommands.length,
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveCommandIndex(
          (current) =>
            (current - 1 + visibleSlashCommands.length) %
            visibleSlashCommands.length,
        );
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const command = visibleSlashCommands[selectedCommandIndex];
        if (command) {
          selectSlashCommand(command);
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlashCommandValue(controller.textInput.value);
      }
    },
    [
      conversationId,
      controller.textInput,
      isResponseInFlight,
      isSlashCommandOpen,
      onStop,
      onRestoreExternalMcpSkillAttachment,
      queuedMessages,
      selectSlashCommand,
      selectedCommandIndex,
      textareaRef,
      visibleSlashCommands,
    ],
  );

  return (
    <div className="relative">
      {conversationId && queuedMessages.length > 0 && (
        <div
          className="mb-2 flex max-h-40 flex-col gap-1 overflow-y-auto"
          data-testid={E2eTestId.ChatMessageQueue}
        >
          {queuedMessages.map((queued) => (
            <div
              key={queued.id}
              className="group flex items-center gap-2 rounded-md bg-muted/50 py-1 pr-1 pl-3 text-muted-foreground text-sm transition-colors hover:bg-muted"
              data-testid={E2eTestId.ChatMessageQueueItem}
            >
              <span className="min-w-0 grow truncate">
                {queued.skill ? `/${queued.skill.name} ` : ""}
                {queued.externalMcpSkill
                  ? `${queued.externalMcpSkill.commandValue} `
                  : ""}
                {queued.text}
              </span>
              <Button
                aria-label="Remove queued message"
                className="size-auto shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                data-testid={E2eTestId.ChatMessageQueueRemoveButton}
                onClick={() =>
                  chatMessageQueue.remove(conversationId, queued.id)
                }
                size="icon"
                type="button"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {isSandboxCommandHintVisible && (
        <div className="absolute inset-x-0 bottom-full mb-2 px-3 text-xs text-muted-foreground">
          Messages starting with{" "}
          <span className="font-mono font-medium">!</span> run as commands in
          the sandbox
        </div>
      )}
      {isSlashCommandOpen && (
        <div className="absolute inset-x-0 bottom-full z-50 mb-2 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
          <PromptInputCommand className="h-auto rounded-none bg-transparent">
            <PromptInputCommandList className="max-h-64">
              <PromptInputCommandEmpty>
                No commands found.
              </PromptInputCommandEmpty>
              <PromptInputCommandGroup className="p-1">
                {visibleSlashCommands.map((command, index) => (
                  <PromptInputCommandItem
                    key={command.skill?.id ?? command.value}
                    value={command.value}
                    ref={(node) => {
                      commandItemRefs.current[index] = node;
                    }}
                    onMouseEnter={() => setActiveCommandIndex(index)}
                    onSelect={() => selectSlashCommand(command)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5",
                      index === selectedCommandIndex &&
                        "bg-accent text-accent-foreground",
                    )}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="mt-0.5 font-mono text-sm text-muted-foreground">
                        /
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium">
                          {command.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {command.description}
                        </div>
                      </div>
                    </div>
                    {isContextCompacting && command.value === "/compact" && (
                      <span className="text-xs text-muted-foreground">
                        Running
                      </span>
                    )}
                  </PromptInputCommandItem>
                ))}
              </PromptInputCommandGroup>
            </PromptInputCommandList>
          </PromptInputCommand>
        </div>
      )}
      {/* LockedChat "drawer": a slim strip tucked against the composer's top
          edge, carrying the explanation that used to live in the toggle's
          tooltip. Paired with the dashed composer border below so an
          locked chat is unmistakable while composing. */}
      {executionMode && (
        <div className="mx-3 -mb-px flex items-center gap-2 rounded-t-lg border border-b-0 border-primary/50 bg-primary/5 px-3 py-1.5 text-xs text-muted-foreground animate-in fade-in slide-in-from-bottom-2">
          <TerminalSquare className="size-3.5 text-primary" />
          <span>
            Starts {executionAgentName ?? "this Agent"} in an isolated
            execution. This becomes its live terminal when ready.
          </span>
        </div>
      )}
      {lockedChatActive && !executionMode && (
        <div
          data-testid={E2eTestId.LockedChatNotice}
          className="mx-3 -mb-px flex items-center gap-2 rounded-t-lg border border-b-0 border-dashed border-muted-foreground/60 bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground animate-in fade-in slide-in-from-bottom-2"
        >
          <LockedChatIcon className="size-3.5" />
          <span>
            Locked chat — encrypted with a key that stays in this browser.{" "}
            {appName} cannot read it, and it isn't available on other devices.
          </span>
        </div>
      )}
      <PromptInput
        globalDrop
        multiple
        onSubmit={handleWrappedSubmit}
        accept={showFileUploadButton ? undefined : "application/x-empty"}
        maxFileSize={storageByteLimit}
        onError={handleFileError}
        className={cn(
          executionMode &&
            "[&_[data-slot=input-group]]:border-primary/50 [&_[data-slot=input-group]]:bg-primary/[0.025] [&_[data-slot=input-group]]:!ring-0 [&:has([data-slot=input-group-control]:focus-visible)_[data-slot=input-group]]:!border-primary",
          lockedChatActive &&
            // The dashed border replaces the composer's ring outright (both
            // at once read as two competing outlines). !important because the
            // ring and focus border are has-[]-variant classes on the
            // InputGroup that otherwise win on specificity; focus feedback
            // comes from brightening the dashes instead.
            "[&_[data-slot=input-group]]:border-dashed [&_[data-slot=input-group]]:border-muted-foreground/60 [&_[data-slot=input-group]]:!ring-0 [&:has([data-slot=input-group-control]:focus-visible)_[data-slot=input-group]]:!border-muted-foreground",
        )}
      >
        {/* File attachments display - shown inline above textarea */}
        <PromptInputAttachments className="px-3 pt-2 pb-0">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          {isPlaywrightSetupRequired && conversationId ? (
            <PlaywrightInstallInline
              agentId={agentId ?? undefined}
              conversationId={conversationId}
            />
          ) : (
            <PromptInputTextarea
              placeholder={
                executionMode
                  ? "Describe the task to run..."
                  : conversationId
                    ? "Ask a follow-up..."
                    : (chatPlaceholder ?? "What would you like to get done?")
              }
              ref={textareaRef}
              className="px-4"
              autoFocus
              disabled={composerLocked}
              // In a live conversation, Enter during a stream submits and the
              // submit handler queues the message. On the new-chat composer
              // (no conversation to queue into yet) Enter stays blocked while
              // the conversation is being created.
              disableEnterSubmit={isResponseInFlight && !conversationId}
              onKeyDown={handleTextareaKeyDown}
              data-testid={E2eTestId.ChatPromptTextarea}
            />
          )}
        </PromptInputBody>
        <PromptInputFooter ref={footerRef}>
          <ChatPromptInputTools
            isNarrow={isNarrow}
            toolbarRef={toolbarRef}
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            conversationId={conversationId}
            currentConversationChatApiKeyId={currentConversationChatApiKeyId}
            currentProvider={currentProvider}
            initialApiKeyId={initialApiKeyId}
            onApiKeyChange={onApiKeyChange}
            onProviderChange={onProviderChange}
            allowFileUploads={allowFileUploads}
            lockedChat={lockedChat}
            onLockedChatChange={onLockedChatChange}
            sandboxAvailable={sandboxAvailable}
            isModelsLoading={isModelsLoading}
            tokensUsed={tokensUsed}
            cachedTokens={cachedTokens}
            maxContextLength={maxContextLength}
            agentLlmApiKeyId={agentLlmApiKeyId}
            selectorAgentId={selectorAgentId}
            onAgentChange={onAgentChange}
            modelSource={modelSource}
            toolsUnavailable={toolsUnavailable}
            notRecommendedForAgents={notRecommendedForAgents}
            executionMode={executionMode}
            onResetModelOverride={onResetModelOverride}
            thinkingEffort={thinkingEffort}
            onThinkingEffortChange={onThinkingEffortChange}
            agentRequiresPerUserConnect={agentRequiresPerUserConnect}
            subscriptionConnectRequired={subscriptionConnectRequired}
            subscriptionProvider={subscriptionProvider}
            onSubscriptionConnect={requestSubscriptionConnect}
            subscriptionConnectRequest={subscriptionConnectRequest}
            agentModelDisplayName={agentModelDisplayName}
            textareaRef={textareaRef}
            contextWindow={contextWindow}
            lastCompaction={lastCompaction}
            onCompactConversation={compactConversation}
            isContextCompacting={isContextCompacting}
          />
          {/* shrink-0: the send/mic cluster is a fixed unit and must never
              compress. When the toolbar runs out of room the collapse hook
              folds the inline tools into a menu (freeing space for the pinned
              recorder pill) rather than squeezing the send button. */}
          <div ref={trailingRef} className="flex shrink-0 items-center gap-2">
            {!executionMode && (
              <PromptInputSpeechButton
                textareaRef={textareaRef}
                onTranscriptionChange={handleTranscriptionChange}
              />
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <PromptInputSubmit
                  className="!h-8"
                  status={submitStatus}
                  disabled={
                    composerLocked ||
                    subscriptionConnectRequired ||
                    sendDisabled
                  }
                  onClick={(event) => {
                    // While a response is in-flight the button shows Stop; a
                    // click stops the stream instead of submitting the form
                    // (which would queue the typed text — see onStop docs).
                    // With a queueable draft the button is a Send button, so
                    // the click must submit (and queue) instead; Esc stops.
                    if (onStop && isResponseInFlight && !isQueueingSubmit) {
                      event.preventDefault();
                      onStop();
                    }
                  }}
                />
              </TooltipTrigger>
              <TooltipContent side="top">
                {subscriptionConnectRequired ? (
                  <span>
                    Connect the subscription or choose another credential
                  </span>
                ) : isResponseInFlight && onStop && !isQueueingSubmit ? (
                  <span className="flex items-center gap-1.5">
                    Stop <Kbd>Esc</Kbd>
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    Send <Kbd>Enter</Kbd>
                  </span>
                )}
              </TooltipContent>
            </Tooltip>
          </div>
        </PromptInputFooter>
      </PromptInput>
      <SensitiveDataConfirmDialog
        open={sensitiveDataDialogOpen}
        onConfirm={handleSensitiveDataConfirm}
        onCancel={handleSensitiveDataCancel}
      />
    </div>
  );
};

const ArchestraPromptInput = ({
  onSubmit,
  onStop,
  status,
  selectedModel,
  onModelChange,
  agentId,
  conversationId,
  currentConversationChatApiKeyId,
  currentProvider,
  initialApiKeyId,
  onApiKeyChange,
  onProviderChange,
  textareaRef,
  allowFileUploads = false,
  isModelsLoading = false,
  tokensUsed = 0,
  cachedTokens,
  maxContextLength,
  contextWindow,
  lastCompaction,
  inputModalities,
  agentLlmApiKeyId,
  submitDisabled,
  sendDisabled,
  subscriptionConnectRequired,
  isContextCompacting,
  onCompactConversation,
  isPlaywrightSetupRequired,
  selectorAgentId,
  onAgentChange,
  modelSource,
  toolsUnavailable,
  notRecommendedForAgents,
  onResetModelOverride,
  thinkingEffort,
  onThinkingEffortChange,
  agentRequiresPerUserConnect,
  agentModelDisplayName,
  subscriptionProvider,
  lockedChat,
  onLockedChatChange,
  prefillText,
  onPrefillApplied,
  externalMcpSkillAttachment,
  onRemoveExternalMcpSkillAttachment,
  onRestoreExternalMcpSkillAttachment,
  executionMode,
  executionAgentName,
}: ArchestraPromptInputProps) => {
  const { data: activeAgent } = useProfile(agentId ?? undefined);
  const sandboxAvailable = activeAgent?.sandboxAvailable ?? false;
  const sandboxByteLimit =
    useFeature("sandboxArtifactBytesLimit") ?? DEFAULT_SANDBOX_ARTIFACT_BYTES;
  const storageByteLimit = useChatAttachmentStorageByteLimit();

  // Per-file policy mirroring the backend ingest gate (which is authoritative).
  // Returns a friendly reason to drop the file, or null to accept it.
  const validateFile = useCallback(
    (file: File): string | null => {
      const reason = chatUploadRejectionReason({
        mimeType: getMediaType(file),
        byteLength: file.size,
        ingestibleMimeTypes: getModelReadableMimeTypes(inputModalities),
        sandboxAvailable,
        sandboxByteLimit,
        // Mirrors the backend gate: a file the model can't read — or one too
        // big for the sandbox — is still accepted and lands in the
        // conversation's Files panel, so only the storage cap can reject.
        fileStorageByteLimit: storageByteLimit,
      });
      switch (reason) {
        case null:
          return null;
        // With the Files-panel fallback the only reachable reason is
        // "too_large_to_store"; the other cases stay for exhaustiveness over
        // the shared union.
        case "too_large_to_store":
          return `"${file.name}" exceeds the maximum attachment size of ${formatBytes(storageByteLimit)}.`;
        case "text_too_large":
          return `"${file.name}" is too large to include as text (max ${formatBytes(INLINE_TEXT_MAX_BYTES)}).`;
        case "too_large_for_sandbox":
          return `"${file.name}" exceeds the maximum size of ${formatBytes(sandboxByteLimit)}.`;
        case "unsupported_type":
          return `This model can't read "${file.name}".`;
      }
    },
    [inputModalities, sandboxAvailable, sandboxByteLimit, storageByteLimit],
  );

  const handleProviderFileError = useCallback(
    (err: {
      code: "max_files" | "max_file_size" | "accept" | "rejected";
      message: string;
    }) => {
      if (err.code === "max_file_size") {
        toast.error(
          `File is too large. Maximum size is ${formatBytes(storageByteLimit)}.`,
        );
      } else if (err.code === "max_files") {
        toast.error("Too many files attached.");
      } else if (err.code === "rejected") {
        // Policy rejection (over the storage cap). Gentle, not an error toast —
        // the message already explains the next step.
        toast(err.message);
      }
    },
    [storageByteLimit],
  );

  return (
    <div className="flex size-full flex-col justify-end">
      <PromptInputProvider
        maxFileSize={storageByteLimit}
        validateFile={validateFile}
        onError={handleProviderFileError}
      >
        <PromptInputContent
          onSubmit={onSubmit}
          onStop={onStop}
          status={status}
          selectedModel={selectedModel}
          onModelChange={onModelChange}
          agentId={agentId}
          conversationId={conversationId}
          currentConversationChatApiKeyId={currentConversationChatApiKeyId}
          currentProvider={currentProvider}
          initialApiKeyId={initialApiKeyId}
          onApiKeyChange={onApiKeyChange}
          onProviderChange={onProviderChange}
          textareaRef={textareaRef}
          allowFileUploads={allowFileUploads}
          isModelsLoading={isModelsLoading}
          tokensUsed={tokensUsed}
          cachedTokens={cachedTokens}
          maxContextLength={maxContextLength}
          contextWindow={contextWindow}
          lastCompaction={lastCompaction}
          agentLlmApiKeyId={agentLlmApiKeyId}
          submitDisabled={submitDisabled}
          sendDisabled={sendDisabled}
          subscriptionConnectRequired={subscriptionConnectRequired}
          subscriptionProvider={subscriptionProvider}
          isContextCompacting={isContextCompacting}
          onCompactConversation={onCompactConversation}
          isPlaywrightSetupRequired={isPlaywrightSetupRequired}
          selectorAgentId={selectorAgentId}
          onAgentChange={onAgentChange}
          modelSource={modelSource}
          toolsUnavailable={toolsUnavailable}
          notRecommendedForAgents={notRecommendedForAgents}
          onResetModelOverride={onResetModelOverride}
          thinkingEffort={thinkingEffort}
          onThinkingEffortChange={onThinkingEffortChange}
          agentRequiresPerUserConnect={agentRequiresPerUserConnect}
          agentModelDisplayName={agentModelDisplayName}
          sandboxAvailable={sandboxAvailable}
          lockedChat={lockedChat}
          onLockedChatChange={onLockedChatChange}
          executionMode={executionMode}
          executionAgentName={executionAgentName}
          prefillText={prefillText}
          onPrefillApplied={onPrefillApplied}
          externalMcpSkillAttachment={externalMcpSkillAttachment}
          onRemoveExternalMcpSkillAttachment={
            onRemoveExternalMcpSkillAttachment
          }
          onRestoreExternalMcpSkillAttachment={
            onRestoreExternalMcpSkillAttachment
          }
        />
      </PromptInputProvider>
    </div>
  );
};

export default ArchestraPromptInput;
