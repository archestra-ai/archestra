// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { Bot, Building2, ShieldCheck, UsersRound } from "lucide-react";
import { buildUserSelectItem } from "@/components/user-select-option";
import type { PermissionRecipient } from "@/lib/resource-permissions.query";

export function PermissionRecipientIdentity({
  recipient,
}: {
  recipient: PermissionRecipient;
}) {
  if (recipient.subject.type === "user") {
    return buildUserSelectItem({
      user: {
        userId: recipient.subject.id,
        name: recipient.name,
        email: recipient.email,
      },
    }).content;
  }
  const { icon: Icon, label } = recipientTypes[recipient.subject.type];
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className="size-3" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{recipient.name}</span>
        <span className="truncate text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

const recipientTypes = {
  team: { icon: UsersRound, label: "Team" },
  role: { icon: ShieldCheck, label: "Role" },
  serviceAccount: { icon: Bot, label: "Service account" },
  organization: { icon: Building2, label: "Organization" },
};
