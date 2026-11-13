"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils/tailwind";
import { useSetSettingsPageHeader } from "../layout";
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
  const setPageHeader = useSetSettingsPageHeader();

  // The open provider is the page: name it, and say whether it works.
  // Primitives, not `current`: the provider list is rebuilt on every render.
  const id = current?.id;
  const label = current?.label;
  const active = current?.active;
  useEffect(() => {
    if (!id || !label) return;
    setPageHeader({
      title:
        id === "jira" ? (
          <span className="flex items-center gap-2">
            {label}
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
          </span>
        ) : (
          label
        ),
      documentTitle: label,
      description: PROVIDER_DESCRIPTIONS[id],
      status: (
        <Badge
          variant="secondary"
          className={cn(
            "font-normal",
            active && "bg-green-500/10 text-green-600 dark:text-green-400",
          )}
        >
          {active ? "Active" : "Not set up"}
        </Badge>
      ),
    });
    return () => setPageHeader(null);
  }, [id, label, active, setPageHeader]);

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
      {children}
    </div>
  );
}

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  slack: "Reach agents from Slack channels and direct messages.",
  "ms-teams": "Reach agents from Microsoft Teams chats and channels.",
  email: "Reach agents by email through a shared mailbox.",
  jira: "Reach agents from Jira issue comments.",
  telegram: "Reach agents through a Telegram bot.",
};
