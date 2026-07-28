"use client";

import { KeyRound } from "lucide-react";
import { CopyableCode } from "@/components/copyable-code";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export type CreatedCredentials = {
  clientId: string;
  clientSecret: string;
  grantType: "client_credentials" | "authorization_code";
  // The OAuth scope this client requests ("mcp" for gateways/agents,
  // "llm:proxy" for LLM proxies) — shown in the authorization-code hint.
  oauthScope: string;
};

export function OAuthClientCreatedDialog({
  open,
  onOpenChange,
  title,
  credentials,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  credentials: CreatedCredentials | null;
}) {
  const endpoint = (path: string) =>
    typeof window === "undefined"
      ? path
      : new URL(path, window.location.origin).toString();
  const isAuthorizationCode = credentials?.grantType === "authorization_code";

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="Copy the client secret now. It will not be shown again."
    >
      <DialogBody className="space-y-4">
        {credentials && (
          <>
            <div className="space-y-2">
              <Label>Client ID</Label>
              <CopyableCode value={credentials.clientId} />
            </div>
            <div className="space-y-2">
              <Label>Client Secret</Label>
              <CopyableCode value={credentials.clientSecret} />
            </div>
            {isAuthorizationCode && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <KeyRound className="h-4 w-4" />
                  Authorization endpoint
                </div>
                <CopyableCode value={endpoint("/api/auth/oauth2/authorize")} />
                <p className="mt-2 text-muted-foreground">
                  Use the authorization code flow with PKCE and the{" "}
                  <code>{credentials.oauthScope}</code> scope.
                </p>
              </div>
            )}
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="mb-2 flex items-center gap-2 font-medium">
                <KeyRound className="h-4 w-4" />
                Token endpoint
              </div>
              <CopyableCode value={endpoint("/api/auth/oauth2/token")} />
            </div>
          </>
        )}
      </DialogBody>
      <DialogStickyFooter>
        <Button type="button" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}
