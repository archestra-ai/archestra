"use client";

import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { cn } from "@/lib/utils/tailwind";
import { AccountChip } from "./account-chip";

/** The organization's connected GitHub Apps, one to pick, with where each is installed. */
export function GithubAppPicker({
  apps,
  value,
  onChange,
  idPrefix,
}: {
  apps: Array<{
    id: string;
    name: string;
    icon: string | null;
    account?: string | null;
  }>;
  value: string;
  onChange: (id: string) => void;
  idPrefix: string;
}) {
  return (
    <RadioGroup
      value={value}
      onValueChange={onChange}
      // About three Apps show; more scroll inside the list.
      className="max-h-[9.5rem] gap-2 overflow-y-auto p-px"
      aria-label="GitHub App"
    >
      {apps.map((app) => (
        <Label
          key={app.id}
          htmlFor={`${idPrefix}-${app.id}`}
          className={cn(
            radioCardClass(),
            "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 font-normal",
          )}
        >
          <RadioGroupItem value={app.id} id={`${idPrefix}-${app.id}`} />
          <RuntimeCredentialIcon
            icon={app.icon ?? "logo:github"}
            className="size-4"
            size={16}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {app.name}
          </span>
          {app.account ? <AccountChip account={app.account} /> : null}
        </Label>
      ))}
    </RadioGroup>
  );
}
