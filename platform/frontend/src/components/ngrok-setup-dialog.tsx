"use client";

import { useEffect, useState } from "react";
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
import { SecretInput } from "@/components/ui/secret-input";
import {
  useConnectNgrok,
  useNgrokConfig,
} from "@/lib/chatops/chatops-config.query";
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
  const { data: savedConfig } = useNgrokConfig(open);
  const [authToken, setAuthToken] = useState("");
  const [tokenFocused, setTokenFocused] = useState(false);
  const [domain, setDomain] = useState("");
  const [domainTouched, setDomainTouched] = useState(false);

  // A token saved from an earlier connect is reused server-side when the
  // field is left empty — it is never sent back to the browser.
  const hasSavedToken = !!savedConfig?.hasAuthToken;
  const canConnect = !!authToken.trim() || hasSavedToken;
  // Show bullets as the field value (not just placeholder) so a saved token
  // reads as prefilled. They only render while the field is blurred and
  // empty, so they can never be submitted as the token itself.
  const showSavedTokenMask = hasSavedToken && !tokenFocused && !authToken;

  useEffect(() => {
    if (open && savedConfig && !domainTouched) {
      setDomain(savedConfig.domain);
    }
  }, [open, savedConfig, domainTouched]);

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setAuthToken("");
      setTokenFocused(false);
      setDomain("");
      setDomainTouched(false);
    }
  };

  const handleConnect = () => {
    connectNgrok.mutate(
      {
        authToken: authToken.trim() || undefined,
        domain: domain.trim() || undefined,
      },
      {
        onSuccess: (data) => {
          if (data?.success) handleOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Connect {appName} to ngrok</DialogTitle>
          <DialogDescription>
            {appName} brings up the tunnel for you — paste your ngrok auth token
            and connect.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4 p-3">
          <div className="space-y-1.5">
            <SecretInput
              // masked={false}: the value swap below already renders the
              // saved-token mask, and a newly typed token stays visible
              // (this dialog's pre-SecretInput behavior)
              masked={false}
              placeholder={
                hasSavedToken
                  ? "leave empty to reuse the saved token"
                  : "ngrok auth token"
              }
              value={showSavedTokenMask ? "••••••••" : authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              onFocus={() => setTokenFocused(true)}
              onBlur={() => setTokenFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConnect) handleConnect();
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
          <div className="space-y-1.5">
            <Input
              aria-label="Reserved domain"
              placeholder="reserved domain (optional)"
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value);
                setDomainTouched(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConnect) handleConnect();
              }}
            />
            <p className="text-xs text-muted-foreground">
              Claim your free static domain at{" "}
              <ExternalDocsLink
                href="https://dashboard.ngrok.com/domains"
                className="inline-flex text-primary"
              >
                dashboard.ngrok.com
              </ExternalDocsLink>{" "}
              → Universal Gateway → Domains → Create Domain. Without it the
              public URL changes on every restart and you'll need to reconfigure
              the messaging endpoint in Azure each time.
            </p>
          </div>
          <Button
            className="w-full"
            disabled={!canConnect || connectNgrok.isPending}
            onClick={handleConnect}
          >
            {connectNgrok.isPending ? "Connecting…" : "Connect"}
          </Button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
