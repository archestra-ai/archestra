"use client";

import { CheckCircle2, Laptop, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { OneOf, TextButton } from "@/app/connection/connect-page-parts";
import { useConnectionBaseUrl } from "@/app/connection/connection-flow.utils";
import { detectPlatform } from "@/app/connection/platform.utils";
import { CopyableCode } from "@/components/copyable-code";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  type DesktopDevice,
  useDesktopDevices,
} from "@/lib/desktop-device.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { bridgeCommand, uninstallCommand } from "@/lib/mcp/mcp-bridge-command";
import { useOrganization } from "@/lib/organization.query";

/**
 * Sets up the MCP bridge on the user's device: why, the command to run, then
 * a live line that waits for the device and says when it is linked. The
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

  return (
    <div className="space-y-4 text-sm">
      <p className="text-pretty">
        {`The MCP bridge lets ${appName} use MCP servers that run on your device. It only starts programs that are already there.`}
      </p>
      <div>
        <p className="font-medium">
          {windows
            ? "Run this command in PowerShell on your device"
            : "Run this command in a terminal on your device"}
        </p>
        <CopyableCode
          value={command}
          toastMessage="Command copied"
          className="mt-2 items-start"
        >
          <pre className="font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            {command}
          </pre>
        </CopyableCode>
        <TextButton
          onClick={() => setWindows(!windows)}
          className="mt-2 text-xs text-muted-foreground"
        >
          <OneOf inline shown={windows ? 0 : 1}>
            <span>Use the macOS / Linux command</span>
            <span>Use the Windows command</span>
          </OneOf>
        </TextButton>
      </div>
      <p className="text-muted-foreground">
        It opens a browser page. Approve your device there.
      </p>
      <output
        aria-live="polite"
        className="flex items-center gap-2.5 rounded-lg border px-3 py-2.5"
      >
        {device ? (
          <CheckCircle2
            className="size-4 shrink-0 text-green-600"
            aria-hidden
          />
        ) : (
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
        )}
        <span key={device ? "linked" : "waiting"} className="font-medium">
          {device ? `${device.name} is linked` : "Waiting for your device..."}
        </span>
      </output>
      <p className="text-xs text-muted-foreground">
        <span>
          The MCP bridge starts by itself when you log in. To remove it from
          your device, run{" "}
        </span>
        <code className="font-mono">{uninstallCommand(windows)}</code>
        <span>.</span>
      </p>
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
      bodyClassName="space-y-4"
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
