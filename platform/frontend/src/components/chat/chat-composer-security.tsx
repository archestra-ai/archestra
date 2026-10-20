"use client";

import { getArchestraToolShortName } from "@archestra/shared";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import {
  OpenAppaAsleepIcon,
  OpenAppaCalmIcon,
  OpenAppaOffIcon,
  OpenAppaShadesIcon,
  OpenAppaSuspiciousIcon,
  OpenAppaZzzIcon,
} from "@/components/openappa-icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { chatBrokeTheGlass } from "@/lib/chat/broke-the-glass";
import { useConversation, useOpenappaStatus } from "@/lib/chat/chat.query";
import appConfig from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";
import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";
import styles from "./chat-composer-security.module.css";

/**
 * Wraps the chat composer. APPA peeks over its top-right corner and reports
 * the session's guardrail labels: calm while `trust` is `trusted`, suspicious
 * otherwise, dashed when enforcement is off. A chat that guardrails don't
 * check shows why: asleep when it started while enforcement was off, in shades
 * when a yell broke the glass. A new chat has no session yet, so it shows calm
 * without labels. On the new-chat page the strip APPA peeks from is reserved,
 * so the composer never shifts when APPA appears. In a started chat it floats
 * above the composer dock instead: reserving it there would widen the dock's
 * opaque background, lifting the message fade and the scroll button with it.
 */
export const ChatComposerSecurity = memo(function ChatComposerSecurity({
  conversationId,
  children,
}: {
  conversationId?: string;
  children?: ReactNode;
}) {
  const enabled = useFeature("openappaEnabled") === true;
  return (
    <div
      className={cn(
        "relative min-w-0",
        enabled && !conversationId && "pt-[30px]",
      )}
    >
      {enabled && <GuardrailPeek conversationId={conversationId} />}
      {children}
    </div>
  );
});

// === Internal ===

type Mood = "calm" | "suspicious" | "off" | "asleep" | "shades";

function GuardrailPeek({ conversationId }: { conversationId?: string }) {
  const enabled = useFeature("openappaEnabled") === true;
  const { data: deployment } = useGuardrailsDeployment();
  const active = enabled && deployment?.active === true;
  const statusQuery = useOpenappaStatus(active ? conversationId : undefined);
  const { data, isError, isSuccess } = statusQuery;
  // A failed refetch can retain cached data. Never present it as current.
  const status = conversationId && active && !isError ? data : null;
  const conversationQuery = useConversation(conversationId, {
    refetchOnMount: false,
  });
  const conversation = conversationQuery.data;
  const hasReply = (conversation?.messages ?? []).some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "assistant",
  );
  // The session only exists once the chat's first turn reaches the model, so
  // an empty status read before that says nothing. A turn paused on a question
  // never finishes, so nothing re-reads it: re-read it here once the chat has
  // a reply the empty answer predates.
  const statusPredatesReply =
    data === null &&
    hasReply &&
    statusQuery.dataUpdatedAt < conversationQuery.dataUpdatedAt;
  const { refetch: refetchStatus } = statusQuery;
  useEffect(() => {
    if (statusPredatesReply) void refetchStatus();
  }, [statusPredatesReply, refetchStatus]);
  const appName = useAppName();
  const { data: canReadPolicy } = useHasPermissions({
    guardrailsPolicy: ["read"],
  });
  const popping = usePopOnTrustDrop(status?.trust);

  // Enforcement is on, the chat has a reply, and a status read after it has
  // no labels. Guardrails don't check this chat, unless it is an encrypted
  // chat this browser has no key for: that one may well be checked, and its
  // labels just aren't readable here.
  const uncovered =
    !!conversationId &&
    active &&
    isSuccess &&
    !isError &&
    data === null &&
    hasReply &&
    !statusPredatesReply &&
    !statusQuery.isFetching &&
    !!conversation &&
    conversation.contentLocked !== true;
  // Until the first reply, a chat reads like a new one: calm, no labels yet.
  // Nothing shows while the first status is still loading.
  const awaitingSession =
    !!conversationId &&
    active &&
    isSuccess &&
    !isError &&
    data === null &&
    !uncovered &&
    !!conversation &&
    conversation.contentLocked !== true;

  const mood: Mood | null =
    enabled && deployment?.featureEnabled && !deployment.enabled
      ? "off"
      : status
        ? status.trust === "trusted"
          ? "calm"
          : "suspicious"
        : uncovered
          ? chatBrokeTheGlass({
              messages: conversation?.messages,
              getToolShortName: (toolName) =>
                getArchestraToolShortName(toolName, {
                  appName,
                  fullWhiteLabeling:
                    appConfig.enterpriseFeatures.fullWhiteLabeling,
                  includeDefaultPrefix: true,
                }),
            })
            ? "shades"
            : "asleep"
          : (!conversationId && active) || awaitingSession
            ? "calm"
            : null;
  if (!mood) return null;

  const Icon = MOOD_ICON[mood];
  const copy = MOOD_COPY[mood];
  // A session that keeps the policy it opened with has no revision to name.
  const snapshot = status?.policyRevision === null;
  const label = status
    ? `Guardrails: trust ${status.trust}, audience ${status.audience}`
    : copy.title;

  return (
    <div
      className={cn(
        "pointer-events-none absolute right-9 z-10 h-[30px] w-12",
        conversationId ? "bottom-full" : "top-0",
      )}
    >
      {status && (
        <output
          aria-label={`Trust: ${status.trust}; audience: ${status.audience}${
            typeof status.policyRevision === "number"
              ? `; policy revision: ${status.policyRevision}`
              : snapshot
                ? "; policy snapshot"
                : ""
          }`}
          className="sr-only"
        />
      )}
      {/* The z's sit outside the clipped window, over APPA's right ear. */}
      {mood === "asleep" && (
        <OpenAppaZzzIcon
          className={cn(
            "absolute -top-3.5 -right-3 h-[18px] w-6 text-muted-foreground",
            styles.zzz,
          )}
        />
      )}
      {/* APPA sits behind the composer's top edge: the window clips the rest. */}
      <div className="absolute inset-0 overflow-hidden">
        {/* No hover tooltip: the panel says the same, and two overlays for one
            glyph read as a duplicate. Hover only lifts APPA. */}
        <Popover>
          <PopoverTrigger asChild>
            <UnstyledButton
              type="button"
              aria-label={label}
              onAnimationEnd={popping.done}
              className={cn(
                // A ring would be clipped by the window; the glyph itself
                // takes the focus colour instead.
                "pointer-events-auto absolute top-0 left-1 cursor-pointer outline-none focus-visible:text-primary",
                styles.appa,
                styles[mood],
                popping.active && styles.pop,
                (mood === "calm" || mood === "asleep") &&
                  "text-muted-foreground hover:text-foreground aria-expanded:text-foreground",
                (mood === "suspicious" || mood === "shades") &&
                  "text-foreground",
                mood === "off" && "text-muted-foreground/80",
              )}
            >
              {popping.active ? (
                <span className="relative block h-9 w-10">
                  <OpenAppaCalmIcon
                    className={cn("absolute inset-0 h-9 w-10", styles.leaving)}
                  />
                  <OpenAppaSuspiciousIcon
                    className={cn("absolute inset-0 h-9 w-10", styles.arriving)}
                  />
                </span>
              ) : (
                <Icon className="h-9 w-10" />
              )}
            </UnstyledButton>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="end"
            sideOffset={4}
            className={cn(
              "p-0 text-xs",
              copy.body ? "w-64" : "w-auto min-w-52",
            )}
          >
            <div
              className={cn(
                "flex items-center gap-2 px-3 font-semibold",
                status || copy.body ? "pt-3 pb-2" : "py-3",
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-[18px] shrink-0",
                  mood === "off" && "text-muted-foreground/80",
                )}
              />
              <PanelTitle linked={canReadPolicy === true}>
                {copy.title}
              </PanelTitle>
            </div>
            {copy.body && (
              <p className="border-t px-3 pt-2 pb-3 leading-relaxed text-muted-foreground">
                {copy.body}
              </p>
            )}
            {status && (
              <div className="border-t py-1 font-mono text-[11px] leading-4 text-muted-foreground">
                <LabelRow name="trust" value={status.trust} />
                <LabelRow name="audience" value={status.audience} />
                {typeof status.policyRevision === "number" && (
                  <LabelRow
                    name="revision"
                    value={String(status.policyRevision)}
                  />
                )}
                {snapshot && (
                  <div className="px-3 py-1.5 font-medium text-foreground">
                    policy snapshot
                  </div>
                )}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function LabelRow({ name, value }: { name: string; value: string }) {
  return (
    <div className="px-3 py-1.5 [overflow-wrap:anywhere]">
      <span>{name}:</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

// Links to the Guardrails page, where the policy is read and enforcement is
// switched, for people who can open it; plain text for everyone else.
function PanelTitle({
  linked,
  children,
}: {
  linked: boolean;
  children: string;
}) {
  if (!linked) return <span>{children}</span>;
  return (
    <Link
      href="/openappa"
      className="inline-flex items-center gap-1 underline decoration-border underline-offset-4 hover:decoration-foreground"
    >
      <span>{children}</span>
      <ArrowUpRight
        aria-hidden="true"
        className="size-3 text-muted-foreground"
      />
    </Link>
  );
}

/**
 * True for one run of the pop animation when `trust` changes to anything but
 * `trusted`. Never on the first value: opening a chat that is already
 * suspicious shows APPA up, without the pop.
 */
function usePopOnTrustDrop(trust: string | undefined) {
  const previous = useRef<string | undefined>(undefined);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!trust) return;
    const before = previous.current;
    previous.current = trust;
    if (before !== undefined && before !== trust && trust !== "trusted") {
      setActive(true);
    }
  }, [trust]);
  return { active, done: () => setActive(false) };
}

const MOOD_ICON = {
  calm: OpenAppaCalmIcon,
  suspicious: OpenAppaSuspiciousIcon,
  off: OpenAppaOffIcon,
  asleep: OpenAppaAsleepIcon,
  shades: OpenAppaShadesIcon,
} as const;

const MOOD_COPY: Record<Mood, { title: string; body?: string }> = {
  calm: { title: "Guardrails are enabled" },
  suspicious: { title: "Guardrails are enabled" },
  off: { title: "Guardrails enforcement is off" },
  asleep: {
    title: "Guardrails don't check this chat",
    body: "It started while enforcement was off. New chats are checked.",
  },
  shades: {
    title: "Guardrails are off in this chat",
    body: "The glass was broken: guardrails turned off for the rest of this chat.",
  },
};
