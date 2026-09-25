"use client";

import { Eye, Hand, MessageCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { openAppaChatHref } from "@/lib/openappa-routes";
import { openAppaUrl } from "./overview-setup-cards";

const SEEN_STORAGE_PREFIX = "openappa-welcome-seen";

/**
 * Opens the welcome dialog once per user and organization, on the first
 * visit that finds OpenAPPA fresh (off, with no saved policy). `show` opens it
 * again on request.
 */
export function useOpenAppaWelcome(isFresh: boolean | undefined) {
  const { data: session } = useSession();
  const organizationId = session?.session.activeOrganizationId;
  const userId = session?.user.id;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isFresh || !organizationId || !userId) return;
    const storageKey = `${SEEN_STORAGE_PREFIX}:${organizationId}:${userId}`;
    if (readSeen(storageKey)) return;
    // Seen once shown, so leaving through the chat link or reloading does
    // not bring it back.
    writeSeen(storageKey);
    setOpen(true);
  }, [isFresh, organizationId, userId]);

  return { open, onOpenChange: setOpen, show: () => setOpen(true) };
}

/**
 * Introduces the guardrail in three short steps and points a new user at the
 * policy chat, which drafts the first policy before an administrator enables it.
 */
export function OpenAppaWelcomeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const appName = useAppName();
  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title="Guardrails for your tool calls"
      description={`${appName} checks every tool call your agents make before it runs. The guardrail is powered by OpenAPPA.`}
      bodyClassName="space-y-4"
      footerClassName="sm:items-center"
      footer={
        <>
          <ExternalDocsLink
            href={openAppaUrl("/how-it-works")}
            className="text-sm sm:mr-auto"
          >
            Read how it works
          </ExternalDocsLink>
          <Button asChild>
            <Link href={openAppaChatHref({ promptKey: "setUpPolicy" })}>
              <MessageCircle />
              <span>Set up with chat</span>
            </Link>
          </Button>
        </>
      }
    >
      <ol className="space-y-4">
        <Step icon={<ShieldCheck />} title="Checks every call">
          Before a tool runs, the guardrail checks where its data may go.
        </Step>
        <Step icon={<Eye />} title="Remembers what was read">
          After an agent reads private or untrusted data, stricter limits apply.
        </Step>
        <Step icon={<Hand />} title="Offers a way forward">
          A blocked call can continue with a person&apos;s approval.
        </Step>
      </ol>
      <p className="text-sm text-muted-foreground">
        Setup starts with a short chat. The agent drafts rules for your tools.
        After saving, an administrator can turn the guardrail on using the
        OpenAPPA switch in the sidebar.
      </p>
    </StandardDialog>
  );
}

function Step({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary [&>svg]:size-4">
        {icon}
      </span>
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {children}
        </p>
      </div>
    </li>
  );
}

function readSeen(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}

function writeSeen(storageKey: string) {
  try {
    localStorage.setItem(storageKey, "1");
  } catch {
    // Without storage the dialog shows on each visit while OpenAPPA is fresh.
  }
}
