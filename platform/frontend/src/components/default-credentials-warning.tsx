"use client";

import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from "@shared";
import { Copy, Link } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useDefaultCredentialsEnabled } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";

export function DefaultCredentialsWarning({
  alwaysShow = false,
}: {
  alwaysShow?: boolean;
}) {
  const { data: session } = authClient.useSession();
  const userEmail = session?.user?.email;
  const { data: defaultCredentialsEnabled, isLoading } =
    useDefaultCredentialsEnabled();
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);

  const copyToClipboard = async (text: string, type: "email" | "password") => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "email") {
        setCopiedEmail(true);
        setTimeout(() => setCopiedEmail(false), 2000);
      } else {
        setCopiedPassword(true);
        setTimeout(() => setCopiedPassword(false), 2000);
      }
    } catch (_error) {
      // Fallback for older browsers or when clipboard API is not available
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand("copy");
        if (type === "email") {
          setCopiedEmail(true);
          setTimeout(() => setCopiedEmail(false), 2000);
        } else {
          setCopiedPassword(true);
          setTimeout(() => setCopiedPassword(false), 2000);
        }
      } catch (err) {
        console.error("Failed to copy:", err);
      }
      document.body.removeChild(textArea);
    }
  };

  // Loading state - don't show anything yet
  if (isLoading || defaultCredentialsEnabled === undefined) {
    return null;
  }

  // If default credentials are not enabled, don't show warning
  if (!defaultCredentialsEnabled) {
    return null;
  }

  // For authenticated users, only show if they're using the default admin email
  if (!alwaysShow && (!userEmail || userEmail !== DEFAULT_ADMIN_EMAIL)) {
    return null;
  }

  const alertContent = (
    <Alert variant="destructive" className="text-xs">
      <AlertTitle className="text-xs font-semibold">
        Default Admin Credentials Enabled
      </AlertTitle>
      <AlertDescription className="text-xs mt-1">
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <code className="break-all">- {DEFAULT_ADMIN_EMAIL}</code>
            <Button
              variant="ghost"
              size="sm"
              className="h-4 w-4 p-0 hover:bg-transparent"
              onClick={() => copyToClipboard(DEFAULT_ADMIN_EMAIL, "email")}
            >
              <Copy size={10} />
            </Button>
            {copiedEmail && <span className="ml-1 text-xs">Copied!</span>}
          </div>
          <div className="flex items-center gap-1">
            <code className="break-all">- {DEFAULT_ADMIN_PASSWORD}</code>
            <Button
              variant="ghost"
              size="sm"
              className="h-4 w-4 p-0 hover:bg-transparent"
              onClick={() =>
                copyToClipboard(DEFAULT_ADMIN_PASSWORD, "password")
              }
            >
              <Copy size={10} />
            </Button>
            {copiedPassword && <span className="ml-1 text-xs">Copied!</span>}
          </div>
        </div>
        <p className="mt-1">
          <a
            href="https://www.archestra.ai/docs/platform-deployment#environment-variables"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center underline"
          >
            <Link className="mr-1 flex-shrink-0" size={12} />
            Change if not running locally!
          </a>
        </p>
      </AlertDescription>
    </Alert>
  );

  // For sign-in page, don't wrap with padding
  if (alwaysShow) {
    return alertContent;
  }

  // For sidebar, keep the padding
  return <div className="px-2 pb-2">{alertContent}</div>;
}
