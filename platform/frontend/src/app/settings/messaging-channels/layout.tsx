"use client";

import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils/tailwind";
import {
  MessagingProvidersRow,
  useMessagingProviders,
} from "./_parts/messaging-providers";

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
          <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <span>{current.label}</span>{" "}
            {current.id === "jira" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" tabIndex={0}>
                    Beta
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Jira messaging channels are under active development.
                </TooltipContent>
              </Tooltip>
            )}
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
