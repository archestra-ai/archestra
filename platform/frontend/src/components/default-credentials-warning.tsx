"use client";

import { DEFAULT_ADMIN_EMAIL } from "@shared";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { authClient } from "@/lib/clients/auth/auth-client";

export function DefaultCredentialsWarning() {
  const { data: session } = authClient.useSession();
  const userEmail = session?.user?.email;

  if (!userEmail || userEmail !== DEFAULT_ADMIN_EMAIL) {
    return null;
  }

  return (
    <div className="px-6 pt-4">
      <Alert variant="destructive" className="mb-4">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle className="text-md font-bold">
          Security Warning: Default Admin Credentials Detected
        </AlertTitle>
        <AlertDescription>
          <p>
            You are currently logged in as the workspace owner using default
            admin email. To secure your workspace and prevent unauthorized
            access, please set the{" "}
            <code className="relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm inline">
              BETTER_AUTH_ADMIN_EMAIL
            </code>{" "}
            and{" "}
            <code className="relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm">
              BETTER_AUTH_ADMIN_PASSWORD
            </code>{" "}
            environment variables.
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
