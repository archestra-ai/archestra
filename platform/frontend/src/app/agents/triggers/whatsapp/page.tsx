"use client";

import { Smartphone } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import {
  useDisconnectWhatsApp,
  useUpdateWhatsAppChatOpsConfig,
  useWhatsAppQrCode,
} from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { CollapsibleSetupSection } from "../_components/collapsible-setup-section";
import { SetupStep } from "../_components/setup-step";
import { useTriggerStatuses } from "../_components/use-trigger-statuses";

export default function WhatsAppPage() {
  const appName = useAppName();
  const { data: chatOpsProviders } = useChatOpsStatus();
  const { whatsApp: allStepsCompleted } = useTriggerStatuses();

  const whatsApp = chatOpsProviders?.find((p) => p.id === "whatsapp");
  const isConnected = whatsApp?.configured ?? false;

  const { data: qrData, refetch: refetchQr } = useWhatsAppQrCode({
    enabled: !isConnected,
  });

  const updateConfig = useUpdateWhatsAppChatOpsConfig();
  const disconnectMutation = useDisconnectWhatsApp();

  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  // Poll for QR / connection status while not yet connected
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (isConnected) {
      if (pollingRef.current) clearInterval(pollingRef.current);
      return;
    }
    pollingRef.current = setInterval(() => {
      refetchQr();
    }, 3000);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [isConnected, refetchQr]);

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
        },
      },
    );
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate();
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
          description={`Scan the QR code with WhatsApp on your phone to link it to ${appName}. No business account needed.`}
          done={isConnected}
          ctaLabel={isConnected ? undefined : "Enable WhatsApp"}
          onCtaClick={!isConnected && !qrData?.qrCode ? handleEnable : undefined}
        >
          {isConnected ? (
            <div className="flex items-center gap-3">
              <Smartphone className="h-5 w-5 text-green-500" />
              <span className="text-sm text-muted-foreground">
                WhatsApp connected
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={disconnectMutation.isPending}
              >
                Disconnect
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
          description="Tell Archestra which WhatsApp phone number belongs to which user email so incoming messages can be routed correctly."
          done={false}
        >
          <div className="flex flex-col gap-2 max-w-sm">
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

    </div>
  );
}
