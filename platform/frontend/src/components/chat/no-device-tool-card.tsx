"use client";

import { useState } from "react";
import { McpBridgeSetupDialog } from "@/components/mcp-bridge-setup";
import { noDevicePromptCopy } from "@/lib/chat/mcp-error-ui";
import { useDesktopDevices } from "@/lib/desktop-device.query";
import { AuthErrorTool } from "./auth-error-tool";

/**
 * The card for a tool call that found no device with the MCP bridge. Its
 * button opens the MCP bridge setup, the same one as the Device page; once a
 * device is linked the card says so.
 */
export function NoDeviceToolCard() {
  const [setupOpen, setSetupOpen] = useState(false);
  // Not live: the dialog follows the devices while it is open, and this
  // reads them again while none is known.
  const { data: devices } = useDesktopDevices({ live: false });
  const linked = (devices?.length ?? 0) > 0;
  const copy = noDevicePromptCopy({ linked });
  return (
    <>
      <AuthErrorTool
        {...copy}
        variant={linked ? "success" : "error"}
        onAction={linked ? undefined : () => setSetupOpen(true)}
      />
      <McpBridgeSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
    </>
  );
}
