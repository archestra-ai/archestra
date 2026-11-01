"use client";

import { Info, Laptop, Unplug } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { JsonCodeBlock } from "@/components/json-code-block";
import { QueryLoadError } from "@/components/query-load-error";
import { SecretCopyButton } from "@/components/secret-copy-button";
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
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getExternalProxyUrls } from "@/lib/config/config";
import {
  useDeviceMcpConnections,
  usePairDeviceMcp,
  useRevokeDeviceMcp,
} from "@/lib/mcp/device-mcp.query";
import { useOrganization } from "@/lib/organization.query";

const STATUS_LABELS = {
  setup_required: "Finish setup",
  offline: "Offline",
  online: "Online",
  update_required: "Configuration changed",
  revoked: "Revoked",
} as const;

export function DeviceMcpSetup({ catalogId }: { catalogId: string }) {
  const organization = useOrganization();
  const enabled = organization.data?.deviceMcpEnabled === true;
  const connections = useDeviceMcpConnections(catalogId, enabled);
  const pair = usePairDeviceMcp();
  const revoke = useRevokeDeviceMcp();
  const form = useForm({ defaultValues: { name: "", replaceExisting: false } });
  const existing = connections.data?.find((item) => item.status !== "revoked");
  const { reset: resetPair, data: pairing } = pair;

  useEffect(() => {
    if (!pairing) return;
    const timer = setTimeout(
      resetPair,
      Math.max(0, new Date(pairing.expiresAt).getTime() - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [pairing, resetPair]);

  if (organization.isPending) return null;
  if (organization.isError) {
    return (
      <QueryLoadError
        title="Could not load device settings"
        error={organization.error}
        onRetry={() => organization.refetch()}
        className="h-auto"
      />
    );
  }
  if (!enabled) {
    return (
      <InlineNotice variant="info">
        <Info />
        <span className="font-medium">Device connections are disabled</span>
        <InlineNoticeText>
          Enable Device MCP servers in Settings → MCP before connecting a
          device.
        </InlineNoticeText>
      </InlineNotice>
    );
  }

  const handlePair = form.handleSubmit(async (values) => {
    await pair.mutateAsync({
      catalogId,
      name: values.name.trim(),
      replaceExisting: Boolean(existing) && values.replaceExisting,
    });
    form.reset({ name: values.name, replaceExisting: false });
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Laptop className="size-4" />
          <span>Your device connection</span>
        </CardTitle>
        <CardDescription>
          Connect this server on your own Mac or Windows device. Agents and
          gateways use your connection when they act as you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connections.isPending ? (
          <output>
            <span>Loading your device connection…</span>
          </output>
        ) : connections.isError ? (
          <QueryLoadError
            title="Could not load your device connection"
            error={connections.error}
            onRetry={() => connections.refetch()}
            className="h-auto"
          />
        ) : (
          <>
            {connections.data?.map((connection) => (
              <div
                key={connection.id}
                className="flex flex-wrap items-center gap-2 rounded-md border p-3"
              >
                <span className="font-medium">{connection.name}</span>
                <Badge variant="outline">
                  {STATUS_LABELS[connection.status]}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Configuration {connection.configVersion}
                </span>
                {connection.status !== "revoked" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    disabled={revoke.isPending}
                    onClick={async () => {
                      await revoke.mutateAsync(connection.id);
                      pair.reset();
                    }}
                  >
                    <Unplug />
                    <span>Revoke connection</span>
                  </Button>
                )}
              </div>
            ))}
            {existing?.status === "offline" && (
              <InlineNotice variant="warning">
                <Info />
                <span className="font-medium">Your device is offline</span>
                <InlineNoticeText>
                  Wake your device and restart its connector. Tool calls fail
                  while it is unavailable; they are not replayed later.
                </InlineNoticeText>
              </InlineNotice>
            )}
            {existing?.status === "update_required" && (
              <InlineNotice variant="warning">
                <Info />
                <span className="font-medium">
                  Review the changed configuration
                </span>
                <InlineNoticeText>
                  Pair again to review and approve the current launch settings.
                  Your existing connector cannot run the changed configuration.
                </InlineNoticeText>
              </InlineNotice>
            )}
            <form onSubmit={handlePair} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor={`device-name-${catalogId}`}>Device name</Label>
                <Input
                  id={`device-name-${catalogId}`}
                  placeholder="My laptop"
                  maxLength={100}
                  {...form.register("name", {
                    required: "Enter a device name",
                    validate: (value) =>
                      value.trim().length > 0 || "Enter a device name",
                  })}
                  aria-invalid={Boolean(form.formState.errors.name)}
                />
                {form.formState.errors.name && (
                  <p className="text-sm text-destructive" role="alert">
                    {form.formState.errors.name.message}
                  </p>
                )}
              </div>
              {existing && (
                <div className="flex items-start gap-2">
                  <Checkbox
                    id={`replace-device-${catalogId}`}
                    checked={form.watch("replaceExisting")}
                    onCheckedChange={(checked) =>
                      form.setValue("replaceExisting", checked === true)
                    }
                  />
                  <Label htmlFor={`replace-device-${catalogId}`}>
                    Replace my selected device and disconnect its existing
                    connector
                  </Label>
                </div>
              )}
              <Button
                type="submit"
                size="sm"
                disabled={
                  pair.isPending ||
                  (Boolean(existing) && !form.watch("replaceExisting"))
                }
              >
                <span>
                  {pair.isPending ? "Preparing setup…" : "Prepare device setup"}
                </span>
              </Button>
            </form>
          </>
        )}
        {pairing && <PairingInstructions pairing={pairing} />}
      </CardContent>
    </Card>
  );
}

function PairingInstructions({
  pairing,
}: {
  pairing: NonNullable<ReturnType<typeof usePairDeviceMcp>["data"]>;
}) {
  const externalUrl = getExternalProxyUrls()[0];
  const origin = externalUrl ? new URL(externalUrl).origin : "";
  const commandFor = (os: string, code: string) => {
    const quote = (value: string) =>
      `'${value.replaceAll("'", os === "windows" ? "''" : "'\\''")}'`;
    return `pnpm --dir backend exec tsx src/device-mcp-client/cli.ts --url ${quote(origin)} --code ${quote(code)}`;
  };

  return (
    <div className="space-y-3 rounded-md border p-4">
      <h3 className="font-medium">Finish setup on your device</h3>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          Review the launch configuration below. The connector asks for your
          consent before starting this process.
        </li>
        <li>
          In a source checkout with dependencies installed, open the platform
          directory on your device. Choose Copy with real token to include your
          one-time pairing code, then run the copied command.
        </li>
        <li>
          Keep the connector running. This page updates to Online after it
          connects.
        </li>
      </ol>
      <Tabs defaultValue="mac">
        <TabsList aria-label="Device operating system">
          <TabsTrigger value="mac">macOS</TabsTrigger>
          <TabsTrigger value="windows">Windows PowerShell</TabsTrigger>
        </TabsList>
        {["mac", "windows"].map((os) => (
          <TabsContent key={os} value={os}>
            <div className="flex items-start gap-2 rounded-md bg-muted p-3">
              <code className="min-w-0 flex-1 break-all text-xs">
                {commandFor(os, "PAIRING_CODE")}
              </code>
              <SecretCopyButton
                placeholderText={commandFor(os, "PAIRING_CODE")}
                getSecretText={async () => commandFor(os, pairing.code)}
              />
            </div>
          </TabsContent>
        ))}
      </Tabs>
      <p className="text-xs text-muted-foreground">
        <span>
          This one-time code expires at{" "}
          {new Date(pairing.expiresAt).toLocaleTimeString()}. The connector
          keeps its 24-hour credential in memory; restart requires pairing
          again.
        </span>
      </p>
      <details>
        <summary className="cursor-pointer text-sm">
          Review launch configuration
        </summary>
        <JsonCodeBlock
          value={pairing.config}
          maxHeightClassName="max-h-72 overflow-auto"
        />
        <p className="break-all text-xs text-muted-foreground">
          Configuration fingerprint: {pairing.configDigest}
        </p>
      </details>
      <InlineNotice variant="neutral">
        <Info />
        <span className="font-medium">Source CLI concept</span>
        <InlineNoticeText>
          This setup does not install a background service. macOS and Windows
          use the same source command; Windows device validation is pending.
        </InlineNoticeText>
      </InlineNotice>
    </div>
  );
}
