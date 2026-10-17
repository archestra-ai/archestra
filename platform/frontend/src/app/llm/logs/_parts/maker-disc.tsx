"use client";

import type { SupportedProvider } from "@archestra/shared";
import Image from "next/image";
import { providerLogoUrl } from "@/lib/provider-logos";
import { cn } from "@/lib/utils/tailwind";

/** A model maker's logo on a disc, or its initial when there is no logo. */
export function MakerDisc({
  provider,
  vendor,
  size = 20,
  ring = true,
}: {
  provider: SupportedProvider | null;
  vendor: string;
  size?: number;
  /** Separates overlapping discs from what they sit on. */
  ring?: boolean;
}) {
  const logo = Math.round(size * 0.55);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border border-border/70 bg-background",
        ring && "ring-2 ring-background",
      )}
      style={{ width: size, height: size }}
    >
      {provider ? (
        <Image
          src={providerLogoUrl(provider)}
          alt={vendor}
          width={logo}
          height={logo}
          className="shrink-0 object-contain dark:invert"
        />
      ) : (
        <span
          role="img"
          aria-label={vendor}
          className="font-semibold text-muted-foreground"
          style={{ fontSize: Math.max(9, Math.round(size * 0.42)) }}
        >
          {vendor.charAt(0).toUpperCase()}
        </span>
      )}
    </span>
  );
}
