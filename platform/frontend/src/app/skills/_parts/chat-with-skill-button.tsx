"use client";

import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  getSkillActionModel,
  skillAction,
  skillActionHref,
} from "./skill-actions-model";

export function ChatWithSkillButton({ skillId }: { skillId: string }) {
  const action = skillAction(getSkillActionModel(skillId), "chat");
  return (
    <PermissionButton
      permissions={action.permissions}
      variant="outline"
      asChild
    >
      <Link href={skillActionHref(action)}>
        <MessageSquare className="h-4 w-4" />
        {action.label}
      </Link>
    </PermissionButton>
  );
}
