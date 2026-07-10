"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SecretInput } from "@/components/ui/secret-input";
import { useUpdateTelegramChatOpsConfig } from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";

/**
 * Collects a Telegram bot token from @BotFather. That's the entire setup —
 * Telegram is polled by the backend, so no webhook URL or signing secret.
 */
export function TelegramSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const appName = useAppName();
  const updateConfig = useUpdateTelegramChatOpsConfig();
  const [botToken, setBotToken] = useState("");

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) setBotToken("");
  };

  const handleSave = () => {
    updateConfig.mutate(
      { enabled: true, botToken: botToken.trim() },
      {
        onSuccess: (data) => {
          if (data?.success) handleOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up Telegram</DialogTitle>
          <DialogDescription>
            Create a bot with @BotFather and paste its token — that's all{" "}
            {appName} needs.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <ol className="list-decimal pl-5 text-sm text-muted-foreground flex flex-col gap-1.5">
            <li>
              Open{" "}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                @BotFather
              </a>{" "}
              in Telegram and send <code className="text-xs">/newbot</code>
            </li>
            <li>Choose a display name and a unique username for your bot</li>
            <li>
              Copy the bot token BotFather replies with and paste it below
            </li>
          </ol>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Bot Token</span>
            <SecretInput
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            To let the bot see regular messages in group chats, disable Group
            Privacy for it in BotFather (Bot Settings → Group Privacy), then
            re-add the bot to the group. With privacy on, it only receives
            @mentions, replies, and commands.
          </p>
          <div className="flex justify-end">
            <Button
              onClick={handleSave}
              disabled={!botToken.trim() || updateConfig.isPending}
            >
              {updateConfig.isPending ? "Verifying…" : "Save"}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
