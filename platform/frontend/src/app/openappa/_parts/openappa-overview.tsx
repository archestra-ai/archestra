"use client";

import type { OpenAppaPolicyTargetKind } from "@archestra/shared";
import { CircleHelp } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { SuggestedPrompt } from "@/app/chat/suggested-prompt-pills";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { GithubSyncNotice } from "./github-sync-notice";
import { PolicyChatStarter } from "./policy-chat-starter";

export function OpenAppaOverview({
  initialPrompt,
  conversationId,
  title,
  subtitle,
  suggestedPrompts,
  policyTarget,
}: {
  initialPrompt?: string;
  conversationId?: string;
  title?: string;
  subtitle?: string;
  suggestedPrompts?: readonly SuggestedPrompt[];
  policyTarget?: { kind: OpenAppaPolicyTargetKind; id: string };
}) {
  const [chatStarted, setChatStarted] = useState(false);
  const showChat = chatStarted || Boolean(conversationId);
  return (
    <div
      className={`flex min-h-[28rem] flex-1 flex-col ${showChat ? "" : "gap-6"}`}
    >
      <div
        data-openappa-notices
        className="grid overflow-hidden transition-[grid-template-rows,opacity,transform] duration-300 ease-out"
        style={{
          gridTemplateRows: showChat ? "0fr" : "1fr",
          opacity: showChat ? 0 : 1,
          transform: showChat ? "translateY(-8px)" : "translateY(0)",
        }}
      >
        <div className="min-h-0 space-y-2 overflow-hidden">
          <GithubSyncNotice />
          <InlineNotice
            variant="warning"
            className="grid grid-cols-[auto_minmax(0,1fr)] items-start sm:flex sm:items-center"
          >
            <CircleHelp />
            <span className="font-medium">Using Claude Code?</span>
            <InlineNoticeText className="col-start-2">
              Configure policies here, then install the client integration from{" "}
              <Link href="/plugins" className="underline underline-offset-4">
                Plugins
              </Link>
              .
            </InlineNoticeText>
          </InlineNotice>
        </div>
      </div>
      <PolicyChatStarter
        initialPrompt={initialPrompt}
        conversationId={conversationId}
        onConversationStart={() => setChatStarted(true)}
        title={title}
        subtitle={subtitle}
        suggestedPrompts={suggestedPrompts}
        policyTarget={policyTarget}
      />
    </div>
  );
}
