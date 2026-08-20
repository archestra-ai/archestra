"use client";

import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { PermissionButton } from "@/components/ui/permission-button";

export function ChatWithSkillButton({ skillId }: { skillId: string }) {
  return (
    <PermissionButton
      permissions={{ chat: ["read", "create"] }}
      variant="outline"
      asChild
    >
      <Link href={`/chat/new?skill_id=${skillId}`}>
        <MessageSquare className="h-4 w-4" />
        Chat with a skill
      </Link>
    </PermissionButton>
  );
}
