"use client";

import { useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
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
import { useConnectNgrok } from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";

/**
 * Collects an ngrok auth token and brings the tunnel up live via the API — no
 * restart needed. The resolved public URL appears in the trigger setup once the
 * tunnel connects.
 */
export function NgrokSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const appName = useAppName();
  const connectNgrok = useConnectNgrok();
  const [authToken, setAuthToken] = useState("");

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) setAuthToken("");
  };

  const handleConnect = () => {
    connectNgrok.mutate(
      { authToken },
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
          <DialogTitle>Connect {appName} to ngrok</DialogTitle>
          <DialogDescription>
            {appName} brings up the tunnel for you — paste your ngrok auth token
            and connect.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4 p-3">
          <div className="space-y-1.5">
            <Input
              placeholder="ngrok auth token"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && authToken.trim()) handleConnect();
              }}
            />
            <p className="text-xs text-muted-foreground">
              Get one at{" "}
              <ExternalDocsLink
                href="https://dashboard.ngrok.com/get-started/your-authtoken"
                className="inline-flex text-primary"
              >
                ngrok.com
              </ExternalDocsLink>
            </p>
          </div>
          <Button
            className="w-full"
            disabled={!authToken.trim() || connectNgrok.isPending}
            onClick={handleConnect}
          >
            {connectNgrok.isPending ? "Connecting…" : "Connect"}
          </Button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
