"use client";

import { RefreshCw, Server } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  useCheckSecretsConnectivity,
  useSecretsType,
} from "@/lib/secrets.query";

export default function SecretsSettingsPage() {
  const { data: secretsType, isLoading } = useSecretsType();
  const checkConnectivityMutation = useCheckSecretsConnectivity();
  const [connectivityResult, setConnectivityResult] = useState<{
    connected: boolean;
    secretCount: number;
  } | null>(null);

  const handleCheckConnectivity = async () => {
    setConnectivityResult(null);
    try {
      const result = await checkConnectivityMutation.mutateAsync();
      setConnectivityResult({
        connected: result.connected,
        secretCount: result.secretCount,
      });
    } catch {
      // Error is handled by the mutation
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-lg text-muted-foreground">Loading...</p>
      </div>
    );
  }

  // Don't render anything if not using Vault storage
  if (secretsType?.type !== "Vault") {
    return null;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Secrets Storage
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Button
              onClick={handleCheckConnectivity}
              disabled={checkConnectivityMutation.isPending}
            >
              {checkConnectivityMutation.isPending && (
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              )}
              Check Vault Connectivity
            </Button>
          </div>

          {checkConnectivityMutation.isError && (
            <Alert variant="destructive">
              <AlertTitle>Connection Failed</AlertTitle>
              <AlertDescription>
                {checkConnectivityMutation.error?.message ||
                  "Failed to connect to Vault"}
              </AlertDescription>
            </Alert>
          )}

          {connectivityResult && (
            <Alert>
              <Server className="h-4 w-4" />
              <AlertTitle>Connection Successful</AlertTitle>
              <AlertDescription>
                Connected to Vault. Found {connectivityResult.secretCount}{" "}
                secret{connectivityResult.secretCount === 1 ? "" : "s"} in the
                configured path.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
