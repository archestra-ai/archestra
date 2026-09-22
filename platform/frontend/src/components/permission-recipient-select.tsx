// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { Bot, Building2, ShieldCheck, UsersRound } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { buildUserSelectItem } from "@/components/user-select-option";
import type { PermissionRecipient } from "@/lib/resource-permissions.query";

/** The same searchable picker and identity layout for every permission audience. */
export function PermissionRecipientSelect({
  label,
  recipients,
  loading,
  onSearchChange,
  onSelect,
}: {
  label: string;
  recipients: PermissionRecipient[];
  loading: boolean;
  onSearchChange: (query: string) => void;
  onSelect: (recipient: PermissionRecipient) => void;
}) {
  return (
    <SearchableSelect
      value=""
      ariaLabel={`Add ${label.toLowerCase()}`}
      placeholder={`Choose ${label.toLowerCase()}…`}
      searchPlaceholder={
        label === "People"
          ? "Search by name or email…"
          : `Search ${label.toLowerCase()}…`
      }
      className="w-full"
      onSearchQueryChange={onSearchChange}
      emptyMessage={
        loading ? "Searching…" : "No matching recipients available to add."
      }
      hint="Search to find more results."
      items={
        loading
          ? []
          : recipients.map((recipient) => ({
              value: `${recipient.subject.type}:${recipient.subject.id}`,
              label: recipient.name,
              searchText: `${recipient.name} ${recipient.email ?? ""}`,
              content: <PermissionRecipientIdentity recipient={recipient} />,
            }))
      }
      onValueChange={(key) => {
        const recipient = recipients.find(
          (entry) => `${entry.subject.type}:${entry.subject.id}` === key,
        );
        if (recipient) onSelect(recipient);
        onSearchChange("");
      }}
    />
  );
}

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
