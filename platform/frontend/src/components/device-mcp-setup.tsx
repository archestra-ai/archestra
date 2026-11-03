"use client";

import { Info, Laptop, Unplug } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { JsonCodeBlock } from "@/components/json-code-block";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLocalDevices } from "@/lib/local-devices.query";
import {
  useDeviceMcpConnections,
  useDeviceMcpReview,
  useInstallManagedDeviceMcp,
  useRevokeDeviceMcp,
} from "@/lib/mcp/device-mcp.query";
import { useOrganization } from "@/lib/organization.query";

const statuses = {
  setup_required: "Installing",
  offline: "Offline",
  online: "Online",
  update_required: "Review update",
  revoked: "Removed",
};

/** Personal installations use the same persistent background agent as Devices. */
export function DeviceMcpSetup({ catalogId }: { catalogId: string }) {
  const organization = useOrganization();
  const enabled = organization.data?.deviceMcpEnabled === true;
  const search = useSearchParams();
  const requested = search?.get("setup") === "device";
  const [open, setOpen] = useState(requested);
  const [selected, setSelected] = useState("");
  const [approval, setApproval] = useState<string | null>(null);
  const connections = useDeviceMcpConnections(catalogId, enabled);
  const devices = useLocalDevices({ enabled });
  const review = useDeviceMcpReview(catalogId, enabled);
  const install = useInstallManagedDeviceMcp();
  const revoke = useRevokeDeviceMcp();
  useEffect(() => {
    if (requested) setOpen(true);
  }, [requested]);
  if (!enabled) return null;
  const computers = (devices.data ?? []).filter(
    (device) => device.status !== "revoked" && device.status !== "pending",
  );
  const existing = (connections.data ?? []).filter(
    (connection) => connection.status !== "revoked",
  );
  const target =
    computers.find(
      (device) => device.id === (selected || existing[0]?.localDeviceId),
    ) ?? computers[0];
  const approvalKey = `${target?.id}:${review.data?.configDigest}`;
  const approved = approval === approvalKey;
  const launch = target?.platform
    ? review.data?.config.platforms[target.platform]
    : null;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Laptop className="size-4" />
            <span>Your device installation</span>
          </CardTitle>
          <CardDescription>
            Runs on your selected computer when agents use these tools as you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {connections.isError ? (
            <QueryLoadError
              title="Couldn't load your installations"
              onRetry={() => connections.refetch()}
            />
          ) : (
            existing.map((connection) => (
              <div
                key={connection.id}
                className="flex flex-wrap items-center gap-2 rounded-md border p-3"
              >
                <span className="font-medium">
                  {computers.find(
                    (device) => device.id === connection.localDeviceId,
                  )?.name ?? connection.name}
                </span>
                <Badge variant="outline">{statuses[connection.status]}</Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(connection.id)}
                >
                  <Unplug />
                  <span>Remove installation</span>
                </Button>
              </div>
            ))
          )}
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <span>
              {existing.length
                ? "Review installation"
                : "Install on my computer"}
            </span>
          </Button>
        </CardContent>
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install on your computer</DialogTitle>
            <DialogDescription>
              Your background agent starts this MCP and reconnects it after
              login. Only your tool calls use this installation.
            </DialogDescription>
          </DialogHeader>
          {devices.isError || review.isError ? (
            <QueryLoadError
              title="Couldn't load installation setup"
              onRetry={() => {
                void devices.refetch();
                void review.refetch();
              }}
            />
          ) : devices.isPending || review.isPending ? (
            <p className="text-sm text-muted-foreground">
              Loading installation setup…
            </p>
          ) : !target ? (
            <div className="space-y-3">
              <p className="text-sm">
                Connect a computer first. Run the Connect command on that
                computer, then return here.
              </p>
              <Button asChild>
                <Link href="/connection">Open Connect</Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {existing.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  This replaces your existing installation for this MCP. An
                  interrupted tool call will not be replayed.
                </p>
              )}
              <Select value={target.id} onValueChange={setSelected}>
                <SelectTrigger aria-label="Computer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {computers.map((device) => (
                    <SelectItem key={device.id} value={device.id}>
                      {device.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {launch ? (
                <>
                  <p className="text-sm">
                    The background agent will run this reviewed command:
                  </p>
                  <code className="block break-all rounded-md bg-muted p-3 text-xs">
                    {JSON.stringify([launch.command, ...launch.args])}
                  </code>
                  <details>
                    <summary className="cursor-pointer text-sm">
                      Review tools and configuration
                    </summary>
                    <JsonCodeBlock
                      value={review.data?.config}
                      maxHeightClassName="max-h-48 overflow-auto"
                    />
                  </details>
                  <label
                    htmlFor={`approve-mcp-${catalogId}`}
                    className="flex items-start gap-2 text-sm"
                  >
                    <Checkbox
                      id={`approve-mcp-${catalogId}`}
                      checked={approved}
                      onCheckedChange={(value) =>
                        setApproval(value === true ? approvalKey : null)
                      }
                    />
                    <span>
                      Allow this MCP to run on this computer with my user
                      permissions.
                    </span>
                  </label>
                </>
              ) : (
                <InlineNotice>
                  <Info />
                  <InlineNoticeText>
                    This MCP has no approved command for this computer's
                    operating system.
                  </InlineNoticeText>
                </InlineNotice>
              )}
              {target.status !== "online" && (
                <p className="text-xs text-muted-foreground">
                  This computer is offline. Installation starts when its
                  background agent reconnects. Tool calls fail while it is
                  unavailable.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!approved || !target || !launch || install.isPending}
              onClick={async () => {
                if (!target || !review.data) return;
                await install.mutateAsync({
                  catalogId,
                  localDeviceId: target.id,
                  configDigest: review.data.configDigest,
                  replaceExisting: existing.length > 0,
                });
                setOpen(false);
              }}
            >
              <span>{install.isPending ? "Installing…" : "Install"}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
