"use client";

import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";

/** The first few connected GitHub Apps' icons, overlapping. */
export function AppIconStack({ icons }: { icons: (string | null)[] }) {
  return (
    <span className="flex -space-x-2">
      {icons.slice(0, 3).map((icon, index) => (
        <span
          // Icons repeat and never reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: static decorative stack
          key={index}
          className="flex size-9 items-center justify-center rounded-lg border bg-background"
        >
          <RuntimeCredentialIcon
            icon={icon ?? "logo:github"}
            className="size-4"
            size={16}
          />
        </span>
      ))}
    </span>
  );
}
