"use client";

import { CheckCircle2, Laptop, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  OneOf,
  ScriptBlock,
  SetupNextSteps,
  TextButton,
} from "@/app/connection/connect-page-parts";
import { useConnectionBaseUrl } from "@/app/connection/connection-flow.utils";
import { detectPlatform } from "@/app/connection/platform.utils";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import {
  type DesktopDevice,
  useDesktopDevices,
} from "@/lib/desktop-device.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { bridgeCommand } from "@/lib/mcp/mcp-bridge-command";
import { useOrganization } from "@/lib/organization.query";

/**
 * Sets up the MCP bridge on the user's device, in the look of the Connect
 * page: one line on why, the command, what happens when it finishes, then a
 * live line that waits for the device and says when it is linked. The
 * Device page and the chat open it in {@link McpBridgeSetupDialog}; the
 * registry's Link dialog shows it as one of its own steps, so all three look
 * and move the same.
 *
 * `device` is the user's device once it is linked, null before. The caller
 * reads it live (`useDesktopDevices`), so the line moves on by itself.
 */
export function McpBridgeSetup({ device }: { device: DesktopDevice | null }) {
  const appName = useAppName();
  const { data: organization } = useOrganization();
  const baseUrl = useConnectionBaseUrl(organization?.connectionBaseUrls);
  const [windows, setWindows] = useState(false);
  useEffect(() => setWindows(detectPlatform() === "windows"), []);
  const command = bridgeCommand(baseUrl, windows);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="text-sm">
      <p className="text-muted-foreground text-pretty">
        {`Connect your device to ${appName}, so it can use MCP servers running there. Run this command in ${windows ? "PowerShell" : "a terminal"} on your device.`}
      </p>
      <ScriptBlock
        command={command}
        copied={copied}
        disabled={false}
        onCopy={() => {
          void copyToClipboard(command).then(() => setCopied(true));
        }}
        // The dialog is narrower than the Connect page: the command wraps
        // instead of scrolling, clear of the Copy button.
        className="mt-3 [&_pre]:break-all [&_pre]:whitespace-pre-wrap"
      />
      <SetupNextSteps
        platformControl={
          <TextButton
            onClick={() => setWindows(!windows)}
            className="self-start"
          >
            <OneOf inline shown={windows ? 0 : 1}>
              <span>Use the macOS / Linux command</span>
              <span>Use the Windows command</span>
            </OneOf>
          </TextButton>
        }
      >
        <ol className="mt-1 list-decimal space-y-0.5 pl-4">
          <li>Approve your device on the browser page it opens.</li>
          <li>The MCP bridge then runs in the background.</li>
        </ol>
      </SetupNextSteps>
      <output
        aria-live="polite"
        className="mt-5 flex items-center gap-2 border-t pt-4"
      >
        {device ? (
          <CheckCircle2
            className="size-4 shrink-0 text-green-600"
            aria-hidden
          />
        ) : (
          <Loader2
            className="size-4 shrink-0 animate-spin text-muted-foreground"
            aria-hidden
          />
        )}
        <span
          key={device ? "linked" : "waiting"}
          className={device ? undefined : "text-muted-foreground"}
        >
          {device ? `${device.name} is linked` : "Waiting for your device..."}
        </span>
      </output>
    </div>
  );
}

/**
 * {@link McpBridgeSetup} in a dialog of its own, in the shape of the
 * registry's Link dialog. It follows the user's devices while it is open.
 */
export function McpBridgeSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const devices = useDesktopDevices({ enabled: open });
  const device = devices.data?.[0] ?? null;
  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      size="medium"
      // Wide enough for the command's lines on one line each.
      className="max-w-3xl"
      title={
        <span className="flex items-center gap-2 pr-6 text-left leading-snug">
          <Laptop className="h-5 w-5 shrink-0" />
          <span className="min-w-0">Set up the MCP bridge</span>
        </span>
      }
      footer={
        <Button
          type="button"
          variant={device ? "default" : "outline"}
          onClick={() => onOpenChange(false)}
        >
          <OneOf inline shown={device ? 1 : 0}>
            <span>Close</span>
            <span>Done</span>
          </OneOf>
        </Button>
      }
    >
      <McpBridgeSetup device={device} />
    </StandardDialog>
  );
}
