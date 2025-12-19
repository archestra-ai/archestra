"use client";

import { Building2, CheckIcon, Key, User, Users } from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useUpdateConversation } from "@/lib/chat.query";
import {
  type ChatApiKey,
  type ChatApiKeyScope,
  type SupportedChatProvider,
  useAvailableChatApiKeys,
} from "@/lib/chat-settings.query";
import { cn } from "@/lib/utils";
import { PROVIDER_CONFIG } from "./create-chat-api-key-form";

interface ChatApiKeySelectorProps {
  /** Conversation ID for persisting selection */
  conversationId: string;
  /** Currently selected model (to filter API keys by provider) */
  currentProvider: SupportedChatProvider;
  /** Currently selected API key ID */
  selectedKeyId: string | null;
  /** Whether the selector should be disabled */
  disabled?: boolean;
  /** Number of messages in current conversation (for mid-conversation warning) */
  messageCount?: number;
}

const SCOPE_ICONS: Record<ChatApiKeyScope, React.ReactNode> = {
  personal: <User className="h-3 w-3" />,
  team: <Users className="h-3 w-3" />,
  org_wide: <Building2 className="h-3 w-3" />,
};

/**
 * API Key selector for chat - allows users to select which API key to use for the conversation.
 * Shows available keys for the current provider, grouped by scope.
 */
export function ChatApiKeySelector({
  conversationId,
  currentProvider,
  selectedKeyId,
  disabled = false,
  messageCount = 0,
}: ChatApiKeySelectorProps) {
  const { data: availableKeys = [], isLoading } =
    useAvailableChatApiKeys(currentProvider);
  const updateConversationMutation = useUpdateConversation();
  const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Group keys by scope
  const keysByScope = useMemo(() => {
    const grouped: Record<ChatApiKeyScope, ChatApiKey[]> = {
      personal: [],
      team: [],
      org_wide: [],
    };

    for (const key of availableKeys) {
      grouped[key.scope].push(key);
    }

    return grouped;
  }, [availableKeys]);

  // Find selected key
  const selectedKey = useMemo(() => {
    return availableKeys.find((k) => k.id === selectedKeyId);
  }, [availableKeys, selectedKeyId]);

  const handleSelectKey = (keyId: string) => {
    if (keyId === selectedKeyId) {
      setOpen(false);
      return;
    }

    // If there are messages, show warning dialog
    if (messageCount > 0) {
      setPendingKeyId(keyId);
    } else {
      applyKeyChange(keyId);
    }
    setOpen(false);
  };

  const applyKeyChange = (keyId: string) => {
    updateConversationMutation.mutate({
      id: conversationId,
      chatApiKeyId: keyId,
    });
  };

  const handleConfirmChange = () => {
    if (pendingKeyId) {
      applyKeyChange(pendingKeyId);
      setPendingKeyId(null);
    }
  };

  const handleCancelChange = () => {
    setPendingKeyId(null);
  };

  // If no keys available for this provider
  if (!isLoading && availableKeys.length === 0) {
    return null;
  }

  const providerConfig = PROVIDER_CONFIG[currentProvider];

  const getKeyDisplayName = (key: ChatApiKey) => {
    if (key.scope === "personal") {
      return key.name;
    }
    if (key.scope === "team") {
      return `${key.name} (${key.teamName || "Team"})`;
    }
    return key.name;
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <PromptInputButton disabled={disabled}>
            <Key className="h-3.5 w-3.5" />
            <span className="truncate max-w-[120px]">
              {selectedKey ? getKeyDisplayName(selectedKey) : "Auto"}
            </span>
          </PromptInputButton>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" align="start">
          <div className="space-y-2">
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
              API Key for {providerConfig.name}
            </div>

            {/* Auto option - uses resolution priority */}
            <Button
              variant="ghost"
              className={cn(
                "w-full justify-start gap-2 px-2 py-1.5 h-auto text-sm",
                !selectedKeyId && "bg-accent",
              )}
              onClick={() => {
                if (selectedKeyId) {
                  handleSelectKey("");
                } else {
                  setOpen(false);
                }
              }}
            >
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <Image
                  src={providerConfig.icon}
                  alt={providerConfig.name}
                  width={16}
                  height={16}
                  className="rounded shrink-0"
                />
                <span className="truncate">Auto (recommended)</span>
              </div>
              {!selectedKeyId && <CheckIcon className="h-4 w-4 shrink-0" />}
            </Button>

            {/* Personal keys */}
            {keysByScope.personal.length > 0 && (
              <>
                <div className="px-2 pt-1 text-xs font-medium text-muted-foreground flex items-center gap-1">
                  {SCOPE_ICONS.personal}
                  <span>Personal</span>
                </div>
                {keysByScope.personal.map((key) => (
                  <Button
                    key={key.id}
                    variant="ghost"
                    className={cn(
                      "w-full justify-start gap-2 px-2 py-1.5 h-auto text-sm",
                      selectedKeyId === key.id && "bg-accent",
                    )}
                    onClick={() => handleSelectKey(key.id)}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Image
                        src={providerConfig.icon}
                        alt={providerConfig.name}
                        width={16}
                        height={16}
                        className="rounded shrink-0"
                      />
                      <span className="truncate">{key.name}</span>
                    </div>
                    {selectedKeyId === key.id && (
                      <CheckIcon className="h-4 w-4 shrink-0" />
                    )}
                  </Button>
                ))}
              </>
            )}

            {/* Team keys */}
            {keysByScope.team.length > 0 && (
              <>
                <div className="px-2 pt-1 text-xs font-medium text-muted-foreground flex items-center gap-1">
                  {SCOPE_ICONS.team}
                  <span>Team</span>
                </div>
                {keysByScope.team.map((key) => (
                  <Button
                    key={key.id}
                    variant="ghost"
                    className={cn(
                      "w-full justify-start gap-2 px-2 py-1.5 h-auto text-sm",
                      selectedKeyId === key.id && "bg-accent",
                    )}
                    onClick={() => handleSelectKey(key.id)}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Image
                        src={providerConfig.icon}
                        alt={providerConfig.name}
                        width={16}
                        height={16}
                        className="rounded shrink-0"
                      />
                      <div className="truncate">
                        <span>{key.name}</span>
                        {key.teamName && (
                          <Badge
                            variant="outline"
                            className="ml-1 text-[10px] px-1 py-0"
                          >
                            {key.teamName}
                          </Badge>
                        )}
                      </div>
                    </div>
                    {selectedKeyId === key.id && (
                      <CheckIcon className="h-4 w-4 shrink-0" />
                    )}
                  </Button>
                ))}
              </>
            )}

            {/* Organization keys */}
            {keysByScope.org_wide.length > 0 && (
              <>
                <div className="px-2 pt-1 text-xs font-medium text-muted-foreground flex items-center gap-1">
                  {SCOPE_ICONS.org_wide}
                  <span>Organization</span>
                </div>
                {keysByScope.org_wide.map((key) => (
                  <Button
                    key={key.id}
                    variant="ghost"
                    className={cn(
                      "w-full justify-start gap-2 px-2 py-1.5 h-auto text-sm",
                      selectedKeyId === key.id && "bg-accent",
                    )}
                    onClick={() => handleSelectKey(key.id)}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Image
                        src={providerConfig.icon}
                        alt={providerConfig.name}
                        width={16}
                        height={16}
                        className="rounded shrink-0"
                      />
                      <span className="truncate">{key.name}</span>
                    </div>
                    {selectedKeyId === key.id && (
                      <CheckIcon className="h-4 w-4 shrink-0" />
                    )}
                  </Button>
                ))}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Mid-conversation warning dialog */}
      <AlertDialog
        open={!!pendingKeyId}
        onOpenChange={(open) => !open && handleCancelChange()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Change API key mid-conversation?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Switching API keys during a conversation may affect billing and
              usage tracking. The new key will be used for all subsequent
              messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmChange}>
              Change API Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
