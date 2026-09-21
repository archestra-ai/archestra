"use client";

import { Key } from "lucide-react";
import type { ReactNode } from "react";
import { SettingsBlock } from "@/components/settings/settings-block";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
    <SettingsBlock
      title={title}
      description={description}
      control={showAction ? action : undefined}
    >
      {!showAction && (
        <div>
          {isLoading ? (
            <Skeleton className="h-10 w-full max-w-sm" />
          ) : error ? (
            <InlineNotice variant="error">
              <InlineNoticeText>
                Failed to load token. Please try refreshing the page.
              </InlineNoticeText>
            </InlineNotice>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Key className="mb-4 h-12 w-12 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {emptyDescription}
              </p>
            </div>
          )}
        </div>
      )}
    </SettingsBlock>
  );
}
