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
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { useUpdateWhatsAppChatOpsConfig } from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";

/**
 * Collects WhatsApp Cloud API credentials from Meta Business Manager.
 */
export function WhatsAppSetupDialog({
  open,
  onOpenChange,
  webhookUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  webhookUrl?: string;
}) {
  const appName = useAppName();
  const updateConfig = useUpdateWhatsAppChatOpsConfig();
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setPhoneNumberId("");
      setAccessToken("");
      setVerifyToken("");
      setAppSecret("");
      setBusinessAccountId("");
    }
  };

  const canSave =
    phoneNumberId.trim() !== "" &&
    accessToken.trim() !== "" &&
    verifyToken.trim() !== "" &&
    appSecret.trim() !== "";

  const handleSave = () => {
    updateConfig.mutate(
      {
        enabled: true,
        phoneNumberId: phoneNumberId.trim(),
        accessToken: accessToken.trim(),
        verifyToken: verifyToken.trim(),
        appSecret: appSecret.trim(),
        ...(businessAccountId.trim()
          ? { businessAccountId: businessAccountId.trim() }
          : {}),
      },
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
          <DialogTitle>Set up WhatsApp</DialogTitle>
          <DialogDescription>
            Connect a WhatsApp Business Phone Number using the Meta Cloud API so{" "}
            {appName} agents can receive and reply to WhatsApp messages.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {webhookUrl && (
            <div className="flex flex-col gap-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <span className="font-medium text-foreground">
                Meta Webhook Callback URL
              </span>
              <code className="break-all text-muted-foreground">
                {webhookUrl}
              </code>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Phone Number ID</span>
            <Input
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
              placeholder="123456789012345"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Access Token</span>
            <SecretInput
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="EAA..."
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Webhook Verify Token</span>
            <SecretInput
              value={verifyToken}
              onChange={(e) => setVerifyToken(e.target.value)}
              placeholder="your-verify-token"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Meta App Secret</span>
            <SecretInput
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="app-secret-for-x-hub-signature-256"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Business Account ID (optional)
            </span>
            <Input
              value={businessAccountId}
              onChange={(e) => setBusinessAccountId(e.target.value)}
              placeholder="WABA ID"
            />
          </div>
          <div className="flex justify-end">
            <Button
              onClick={handleSave}
              disabled={!canSave || updateConfig.isPending}
            >
              {updateConfig.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
