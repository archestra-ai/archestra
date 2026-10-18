"use client";

import { useRouter } from "next/navigation";
import { setPendingChatHandoffFiles } from "@/lib/chat/pending-chat-handoff-files";
import { useOpenAppaYellArchive } from "@/lib/openappa-yells.query";
import { useOpenAppaChatLaunch } from "./openappa-chat-button";

/**
 * Investigating a yell in chat: its investigation chat once it has one, else a
 * new chat with the policy agent, its diagnostic archive attached.
 */
export function useYellInvestigation(yell: {
  id: string;
  hasArchive: boolean;
  /** The yell's investigation chat, once one has read it. */
  conversationId: string | null;
}) {
  const router = useRouter();
  const { href, agents, permissions } = useOpenAppaChatLaunch({
    subject: { kind: "yell", yellId: yell.id },
  });
  const archive = useOpenAppaYellArchive();
  const { conversationId } = yell;
  return {
    permissions,
    label: conversationId ? "Open investigation" : "Investigate in chat",
    disabled:
      !conversationId && (archive.isPending || (!href && !agents.isError)),
    launch: () => {
      if (conversationId) {
        router.push(`/chat/${conversationId}`);
        return;
      }
      if (!href) {
        void agents.refetch();
        return;
      }
      if (!yell.hasArchive) {
        router.push(href);
        return;
      }
      archive.mutate(
        { id: yell.id },
        {
          onSuccess: (file) => {
            if (!file) return;
            setPendingChatHandoffFiles([file]);
            router.push(`${href}&attachments=1`);
          },
        },
      );
    },
  };
}
