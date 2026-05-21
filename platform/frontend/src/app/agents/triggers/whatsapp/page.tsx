"use client";

import { Smartphone, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import {
  useDeleteWhatsAppPhoneMapping,
  useDisconnectWhatsApp,
  useSwitchWhatsAppAccount,
  useUpdateWhatsAppChatOpsConfig,
  useWhatsAppQrCode,
} from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ChannelsSection } from "../_components/channels-section";
import { CollapsibleSetupSection } from "../_components/collapsible-setup-section";
import { SetupStep } from "../_components/setup-step";
import type { ProviderConfig } from "../_components/types";
import { useTriggerStatuses } from "../_components/use-trigger-statuses";

const whatsAppProviderConfig: ProviderConfig = {
  provider: "whatsapp",
  providerLabel: "WhatsApp",
  providerIcon: "/icons/whatsapp.svg",
  webhookPath: "",
  docsUrl: null,
  slashCommand: "",
  buildDeepLink: () => "",
  getDmDeepLink: () => null,
};

export default function WhatsAppPage() {
  const appName = useAppName();
  const { data: chatOpsProviders, refetch: refetchStatus } = useChatOpsStatus();
  const { whatsApp: allStepsCompleted } = useTriggerStatuses();

  const whatsApp = chatOpsProviders?.find((p) => p.id === "whatsapp");
  const isConnected = whatsApp?.configured ?? false;

  const { data: qrData, refetch: refetchQr } = useWhatsAppQrCode({
    enabled: true,
  });

  const updateConfig = useUpdateWhatsAppChatOpsConfig();
  const disconnectMutation = useDisconnectWhatsApp();
  const switchAccountMutation = useSwitchWhatsAppAccount();
  const deleteMappingMutation = useDeleteWhatsAppPhoneMapping();

  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  // Phone mappings come from the backend via the QR polling endpoint
  // so they persist across page reloads.
  const mappings: { phone: string; email: string }[] = qrData?.phoneEmailMappings ?? [];

  // Poll for QR / connection status while not yet connected
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (isConnected) {
      if (pollingRef.current) clearInterval(pollingRef.current);
      return;
    }
    pollingRef.current = setInterval(() => {
      refetchQr();
      refetchStatus();
    }, 3000);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [isConnected, refetchQr, refetchStatus]);

  const handleEnable = () => {
    updateConfig.mutate({ enabled: true });
  };

  const handleAddMapping = () => {
    if (!phone.trim() || !email.trim()) return;
    updateConfig.mutate(
      { phoneEmailMappings: [{ phone: phone.trim(), email: email.trim() }] },
      {
        onSuccess: () => {
          setPhone("");
          setEmail("");
          refetchQr();
        },
      },
    );
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate();
  };

  const handleSwitchAccount = () => {
    switchAccountMutation.mutate();
  };

  return (
    <div className="flex flex-col gap-4">
      <CollapsibleSetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={false}
        providerLabel="WhatsApp"
        docsUrl=""
      >
        {/* Step 1 – Enable and scan QR */}
        <SetupStep
          title="Connect your WhatsApp account"
          description={`Scan the QR code with WhatsApp on your phone to link it to ${appName}. No business account needed — works with a personal WhatsApp number.`}
          done={isConnected}
          ctaLabel={isConnected ? undefined : "Enable WhatsApp"}
          onAction={!isConnected && !qrData?.qrCode ? handleEnable : undefined}
        >
          {isConnected ? (
            <div className="flex flex-wrap items-center gap-3">
              <Smartphone className="h-5 w-5 text-green-500" />
              <span className="text-sm text-muted-foreground">
                WhatsApp connected
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={disconnectMutation.isPending || switchAccountMutation.isPending}
              >
                Disconnect
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={handleSwitchAccount}
                disabled={disconnectMutation.isPending || switchAccountMutation.isPending}
              >
                Switch account
              </Button>
            </div>
          ) : qrData?.qrCode ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-xs text-muted-foreground">
                Open WhatsApp → Settings → Linked Devices → Link a Device
              </p>
              <Image
                src={qrData.qrCode}
                alt="WhatsApp QR code"
                width={220}
                height={220}
                unoptimized
              />
              <p className="text-xs text-muted-foreground">
                Status: {qrData.status}
              </p>
            </div>
          ) : null}
        </SetupStep>

        {/* Step 2 – Map phone numbers to users */}
        <SetupStep
          title="Map phone numbers to users"
          description="Map each WhatsApp sender's phone number to their Archestra account email. Only mapped numbers can send messages to agents."
          done={mappings.length > 0}
        >
          <div className="flex flex-col gap-3 max-w-sm">
            {mappings.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {mappings.map((m) => (
                  <div key={m.phone} className="flex items-center gap-2 text-xs">
                    <Badge variant="secondary" className="font-mono shrink-0">
                      +{m.phone}
                    </Badge>
                    <span className="text-muted-foreground">→</span>
                    <span className="text-muted-foreground truncate flex-1">{m.email}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteMappingMutation.mutate(m.phone)}
                      disabled={deleteMappingMutation.isPending}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="wa-phone" className="text-xs">
                  Phone (digits only)
                </Label>
                <Input
                  id="wa-phone"
                  placeholder="14155550100"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="wa-email" className="text-xs">
                  User email
                </Label>
                <Input
                  id="wa-email"
                  type="email"
                  placeholder="user@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>
            <Button
              size="sm"
              onClick={handleAddMapping}
              disabled={!phone || !email || updateConfig.isPending}
            >
              Add mapping
            </Button>
          </div>
        </SetupStep>
      </CollapsibleSetupSection>

      {isConnected && (
        <ChannelsSection providerConfig={whatsAppProviderConfig} />
      )}
    </div>
  );
}
