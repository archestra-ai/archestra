"use client";

import { Key } from "lucide-react";
import type { ReactNode } from "react";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface PlatformTokenCardProps {
  title: ReactNode;
  description: ReactNode;
  isLoading: boolean;
  error?: unknown;
  tokenExists: boolean;
  emptyDescription: ReactNode;
  action: ReactNode;
}

export function PlatformTokenCard({
  title,
  description,
  isLoading,
  error,
  tokenExists,
  emptyDescription,
  action,
}: PlatformTokenCardProps) {
  const showAction = !isLoading && !error && tokenExists;

  return (
    <Card>
      <SettingsCardHeader
        title={title}
        description={description}
        action={showAction ? action : undefined}
      />
      {!showAction && (
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-10 w-full max-w-sm" />
          ) : error ? (
            <Alert variant="destructive">
              <AlertDescription>
                Failed to load token. Please try refreshing the page.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Key className="mb-4 h-12 w-12 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {emptyDescription}
              </p>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
