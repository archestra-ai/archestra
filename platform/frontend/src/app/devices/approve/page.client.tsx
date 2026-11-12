"use client";

import { CheckCircle2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth/auth.query";
import {
  useDecideDesktopDeviceSignIn,
  useDesktopDeviceSignIn,
  useDesktopDevices,
} from "@/lib/desktop-device.query";
import {
  bridgeBackgroundSentence,
  DEVICES_HREF,
  desktopServerStartLabel,
  ownDesktopMcpServers,
} from "@/lib/mcp/desktop-mcp";
import { useMcpRegistryIssueIndex } from "@/lib/mcp/mcp-registry.query";

export default function DeviceApprovalPage() {
  const requestId = useSearchParams().get("request") ?? "";
  const request = useDesktopDeviceSignIn(requestId);
  const decision = useDecideDesktopDeviceSignIn(requestId);
  const [confirmed, setConfirmed] = useState(false);
  const checkboxId = useId();

  return (
    <PageLayout
      maxWidth="wizard"
      title="Link a device"
      description="The MCP bridge on a device asks to be linked to your account."
    >
      <div className="max-w-xl rounded-lg border">
        {decision.data ? (
          <output className="block space-y-3 p-5 text-sm">
            {decision.data.status === "approved" ? (
              <ConnectedNextSteps
                deviceName={request.data?.deviceName ?? null}
                platform={request.data?.platform}
              />
            ) : (
              <InlineNotice variant="neutral">
                <span>Sign-in denied. The device is not linked.</span>
              </InlineNotice>
            )}
          </output>
        ) : request.isError || !requestId ? (
          <div className="p-5">
            <InlineNotice variant="error" role="alert">
              <TriangleAlert aria-hidden />
              <InlineNoticeText>
                This sign-in request is unavailable or expired. Start the MCP
                bridge again.
              </InlineNoticeText>
            </InlineNotice>
          </div>
        ) : !request.data ? (
          <div className="space-y-3 p-5" aria-busy>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-5 w-72" />
            <Skeleton className="h-8 w-40" />
          </div>
        ) : (
          <>
            <div className="space-y-3 p-5">
              <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Terminal code</p>
                  <p className="break-all font-mono text-xl font-semibold tracking-wider">
                    {request.data.userCode}
                  </p>
                </div>
                <p className="break-words pb-1 text-xs text-muted-foreground">
                  <span>from </span>
                  <span className="font-medium text-foreground">
                    {request.data.deviceName}
                  </span>
                </p>
              </div>
              <label
                htmlFor={checkboxId}
                className="flex items-center gap-2.5 text-sm"
              >
                <Checkbox
                  id={checkboxId}
                  checked={confirmed}
                  onCheckedChange={(checked) => setConfirmed(checked === true)}
                />
                <span>This code matches the code in my terminal.</span>
              </label>
              <p className="text-xs text-muted-foreground">
                A device you linked before is unlinked: you have one device at a
                time.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 border-t bg-muted/20 px-5 py-3">
              <Button
                size="sm"
                disabled={!confirmed || decision.isPending}
                onClick={() => decision.mutate({ decision: "approve" })}
              >
                Link this device
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={decision.isPending}
                onClick={() => decision.mutate({ decision: "deny" })}
              >
                Deny
              </Button>
            </div>
          </>
        )}
      </div>
    </PageLayout>
  );
}

/**
 * After the approval: the program in the terminal hands over to the MCP
 * bridge in the background, which starts the servers the user added.
 */
function ConnectedNextSteps({
  deviceName,
  platform,
}: {
  deviceName: string | null;
  platform: Parameters<typeof bridgeBackgroundSentence>[0];
}) {
  const { data: session } = useSession();
  const { data: issueIndex } = useMcpRegistryIssueIndex();
  const { data: devices } = useDesktopDevices();
  const servers = ownDesktopMcpServers({
    catalogItems: issueIndex?.catalogItems,
    servers: issueIndex?.servers,
    viewerId: session?.user?.id,
  });
  const reported = new Map(
    (devices?.[0]?.servers ?? []).map((server) => [
      server.catalogId,
      server.state,
    ]),
  );
  const device = deviceName ?? "your device";

  return (
    <>
      <p className="flex items-center gap-2 font-medium">
        <CheckCircle2 aria-hidden className="size-4 shrink-0 text-green-600" />
        <span>Your device is linked.</span>
      </p>
      <p className="text-muted-foreground">
        {bridgeBackgroundSentence(platform)} The command in your terminal has
        finished, and you can close this page.
      </p>
      {servers.length > 0 ? (
        <div className="space-y-1.5">
          <p>
            <span>The MCP servers you linked start on </span>
            <span className="font-medium">{device}</span>
            <span>:</span>
          </p>
          <ul className="space-y-1 rounded-md border px-3 py-2">
            {servers.map((server) => (
              <li
                key={server.catalogId}
                className="flex min-w-0 items-center gap-2"
              >
                <McpCatalogIcon
                  icon={server.icon}
                  catalogId={server.catalogId}
                  size={15}
                />
                <span className="min-w-0 flex-1 truncate">{server.name}</span>
                {/* What the device reports: a server it did not report yet
                    is starting. */}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {desktopServerStartLabel(reported.get(server.catalogId))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted-foreground">
          <span>Link MCP servers to your device from the </span>
          <Link href="/mcp/registry" className="underline">
            MCP registry
          </Link>
          <span>, and they start there.</span>
        </p>
      )}
      <p className="text-muted-foreground">
        <span>See your device on the </span>
        <Link href={DEVICES_HREF} className="underline">
          Device tab
        </Link>
        <span> of Personal Settings</span>
        <span>.</span>
      </p>
    </>
  );
}
