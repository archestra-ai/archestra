"use client";

import { type LucideIcon, Mail } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useHasPermissions } from "@/lib/auth.query";
import { cn } from "@/lib/utils";

type Trigger = {
  label: string;
  href: string;
  description: string;
} & ({ icon: LucideIcon } | { iconSrc: string });

const triggers: Trigger[] = [
  {
    label: "MS Teams",
    href: "/agent-triggers/ms-teams",
    iconSrc: "/icons/ms-teams.png",
    description: "Chat with you agents via Microsoft Teams",
  },
  {
    label: "Email",
    href: "/agent-triggers/email",
    icon: Mail,
    description: "Let agents respond to incoming emails",
  },
];

export default function AgentTriggersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: canUpdate } = useHasPermissions({
    organization: ["update"],
  });
  const pathname = usePathname();

  if (canUpdate === false) {
    return null;
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="border-b border-border bg-card/30">
        <div className="mx-auto max-w-[1680px] px-6 pt-4 pb-6 md:px-6">
          <h1 className="text-center text-2xl font-semibold tracking-tight mb-4">
            How do you want to chat with your agent?
          </h1>
          <div className="flex justify-center gap-4">
            {triggers.map((trigger) => {
              const isActive =
                pathname === trigger.href ||
                pathname.startsWith(`${trigger.href}/`);
              return (
                <Link
                  key={trigger.href}
                  href={trigger.href}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border-2 px-6 py-4 transition-all",
                    "hover:border-primary/60 hover:bg-primary/5",
                    isActive
                      ? "border-primary bg-primary/10 shadow-sm"
                      : "border-border bg-card",
                  )}
                >
                  {"iconSrc" in trigger ? (
                    <img
                      src={trigger.iconSrc}
                      alt={trigger.label}
                      className="h-5 w-5 shrink-0"
                    />
                  ) : (
                    <trigger.icon
                      className={cn(
                        "h-5 w-5 shrink-0",
                        isActive ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                  )}
                  <div>
                    <div
                      className={cn(
                        "text-sm font-medium",
                        isActive ? "text-primary" : "text-foreground",
                      )}
                    >
                      {trigger.label}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {trigger.description}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
      <div className="w-full h-full">
        <div className="mx-auto w-full max-w-[1680px] px-6 py-4 md:px-6">
          {children}
        </div>
      </div>
    </div>
  );
}
