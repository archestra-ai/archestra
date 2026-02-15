"use client";

import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFeatures } from "@/lib/features.query";
import {
  useDeleteIncomingEmailSubscription,
  useIncomingEmailStatus,
  useRenewIncomingEmailSubscription,
  useSetupIncomingEmailWebhook,
} from "@/lib/incoming-email.query";

export default function EmailPage() {
  const { data: features, isLoading: featuresLoading } = useFeatures();
  const { data: status, isLoading: statusLoading } = useIncomingEmailStatus();
  const setupMutation = useSetupIncomingEmailWebhook();
  const renewMutation = useRenewIncomingEmailSubscription();
  const deleteMutation = useDeleteIncomingEmailSubscription();

  const [webhookUrl, setWebhookUrl] = useState("");

  const isLoading = featuresLoading || statusLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  const emailInfo = features?.incomingEmail;
  if (!emailInfo?.enabled) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Email is not configured</p>
            <p className="text-sm text-muted-foreground">
              See the{" "}
              <Link
                href="https://archestra.ai/docs/platform-agents#incoming-email"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                setup guide
                <ExternalLink className="h-3 w-3" />
              </Link>{" "}
              for supported email providers and configuration.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const handleSetup = async () => {
    if (!webhookUrl) return;
    await setupMutation.mutateAsync(webhookUrl);
    setWebhookUrl("");
  };

  const handleRenew = async () => {
    await renewMutation.mutateAsync();
  };

  const handleDelete = async () => {
    await deleteMutation.mutateAsync();
  };

  const formatExpiryDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const getTimeUntilExpiry = (dateString: string) => {
    const now = new Date();
    const expiry = new Date(dateString);
    const diffMs = expiry.getTime() - now.getTime();

    if (diffMs <= 0) return "Expired";

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;

    if (days > 0) {
      return `${days}d ${remainingHours}h remaining`;
    }
    return `${hours}h remaining`;
  };

  return (
    <div className="space-y-4">
      {/* How It Works Card */}
      <Card>
        <CardHeader>
          <CardTitle>How It Works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            Incoming email allows external users to invoke agents by sending
            emails to auto-generated addresses. Each prompt gets a unique email
            address using plus-addressing.
          </p>
          <p>
            Microsoft Graph subscriptions expire after 3 days. The system
            automatically renews subscriptions 24 hours before expiration. You
            can also manually renew or delete subscriptions from this page.
          </p>
          <p>
            Alternatively, set{" "}
            <code className="bg-muted px-1 py-0.5 rounded">
              ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_WEBHOOK_URL
            </code>{" "}
            to automatically create a subscription on server startup.
          </p>
          <p className="mt-2">
            <Link
              href="https://archestra.ai/docs/platform-agents#incoming-email"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Learn more in our documentation
              <ExternalLink className="h-3 w-3" />
            </Link>
          </p>
        </CardContent>
      </Card>

      {/* Provider Info Card */}
      <Card>
        <CardHeader>
          <CardTitle>Email Provider</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm font-mono bg-muted p-3 rounded space-y-1">
            <p>
              <span className="text-muted-foreground">Provider:</span>{" "}
              {emailInfo.displayName}
            </p>
            <p>
              <span className="text-muted-foreground">Email Domain:</span>{" "}
              {emailInfo.emailDomain}
            </p>
          </div>

          <div className="text-sm text-muted-foreground">
            <p className="font-medium mb-1">Agent Email Format:</p>
            <code className="bg-muted px-2 py-1 rounded">
              {`{configured-mailbox}+agent-{promptId}@${emailInfo.emailDomain}`}
            </code>
            <p className="text-xs mt-1">
              The mailbox portion is the local part of{" "}
              <code className="bg-muted px-1 rounded">
                ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_MAILBOX_ADDRESS
              </code>
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Subscription Status Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {status?.isActive ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <XCircle className="h-5 w-5 text-amber-500" />
            )}
            Webhook Subscription
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {status?.subscription ? (
            <>
              <div className="text-sm font-mono bg-muted p-3 rounded space-y-1">
                <p>
                  <span className="text-muted-foreground">Status:</span>{" "}
                  <span
                    className={
                      status.isActive ? "text-green-500" : "text-amber-500"
                    }
                  >
                    {status.isActive ? "Active" : "Expired"}
                  </span>
                </p>
                <p>
                  <span className="text-muted-foreground">
                    Subscription ID:
                  </span>{" "}
                  {status.subscription.subscriptionId}
                </p>
                <p>
                  <span className="text-muted-foreground">Webhook URL:</span>{" "}
                  {status.subscription.webhookUrl}
                </p>
                <p>
                  <span className="text-muted-foreground">Expires:</span>{" "}
                  {formatExpiryDate(status.subscription.expiresAt)} (
                  {getTimeUntilExpiry(status.subscription.expiresAt)})
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={handleRenew}
                  disabled={renewMutation.isPending}
                  variant="outline"
                >
                  {renewMutation.isPending && (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Renew Subscription
                </Button>
                <Button
                  onClick={handleDelete}
                  disabled={deleteMutation.isPending}
                  variant="destructive"
                >
                  {deleteMutation.isPending && (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Subscription
                </Button>
              </div>
            </>
          ) : (
            <>
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>No Active Subscription</AlertTitle>
                <AlertDescription>
                  Create a webhook subscription to receive incoming email
                  notifications. The subscription will automatically renew
                  before expiration.
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <Label htmlFor="webhookUrl">Webhook URL</Label>
                <div className="flex gap-2">
                  <Input
                    id="webhookUrl"
                    placeholder="https://your-public-domain.com/api/webhooks/incoming-email"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                  />
                  <Button
                    onClick={handleSetup}
                    disabled={setupMutation.isPending || !webhookUrl}
                  >
                    {setupMutation.isPending && (
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Setup Webhook
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter the publicly accessible URL for this Archestra
                  instance&apos;s webhook endpoint. For local development, use a
                  tunnel service like ngrok (e.g.,{" "}
                  <code className="bg-muted px-1 py-0.5 rounded">
                    https://xxx.ngrok-free.app/api/webhooks/incoming-email
                  </code>
                  ). Microsoft Graph will send POST requests to this URL when
                  new emails arrive.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
