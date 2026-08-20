"use client";

import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { PermissionButton } from "@/components/ui/permission-button";
import { ACTION_LABEL } from "@/lib/design/resource-lexicon";

export function ChatWithSkillButton({ skillId }: { skillId: string }) {
  return (
    <PermissionButton
      permissions={{ chat: ["read", "create"] }}
      variant="outline"
      asChild
    >
      <Link href={`/chat/new?skill_id=${skillId}`}>
        <MessageSquare className="h-4 w-4" />
        {ACTION_LABEL.chat}
      </Link>
    </PermissionButton>
  );
}
