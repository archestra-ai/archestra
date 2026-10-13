"use client";

import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils/tailwind";
import {
  MessagingProvidersRow,
  useMessagingProviders,
} from "./_components/messaging-providers";

/**
 * A provider's page. The settings sidebar lists the providers under
 * Messaging Channels, so this only names the open one and says whether it
 * works.
 */
export default function MessagingChannelSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const providers = useMessagingProviders();
  const current = providers.find((provider) => provider.href === pathname);

  if (providers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        <div className="font-medium text-foreground">
          No messaging providers are available
        </div>
        <p className="mt-1">
          Enable a messaging channel under Settings → Agents to configure its
          provider.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <MessagingProvidersRow />
      {current && (
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">
            {current.label}
          </h2>
          <Badge
            variant="secondary"
            className={cn(
              "font-normal",
              current.active &&
                "bg-green-500/10 text-green-600 dark:text-green-400",
            )}
          >
            {current.active ? "Active" : "Not set up"}
          </Badge>
        </div>
      )}
      {children}
    </div>
  );
}
