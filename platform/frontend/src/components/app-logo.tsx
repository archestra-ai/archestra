"use client";

import Image from "next/image";
import { useTheme } from "next-themes";
import config from "@/lib/config";
import { useOrgTheme } from "@/lib/theme.hook";

interface AppLogoProps {
  /**
   * When true (default), the default logo is centered.
   * When false, it's left-aligned with padding (for sidebar use).
   */
  centered?: boolean;
}

export function AppLogo({ centered = true }: AppLogoProps) {
  const { logo, logoDark, isLoadingAppearance } = useOrgTheme() ?? {};
  const { resolvedTheme } = useTheme();
  const effectiveLogo = resolvedTheme === "dark" && logoDark ? logoDark : logo;

  if (isLoadingAppearance) {
    return <div className="h-[47px]" />;
  }

  if (effectiveLogo) {
    return (
      <div className={`flex ${centered ? "justify-center" : "pl-8"}`}>
        <div className="flex flex-col items-center gap-1">
          <Image
            src={effectiveLogo}
            alt="Organization logo"
            width={200}
            height={60}
            className="object-contain h-12 w-auto max-w-[calc(100vw-6rem)]"
          />
          {!config.enterpriseFeatures.fullWhiteLabeling && (
            <p className="text-[10px] text-muted-foreground">
              Powered by Archestra
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-2 ${centered ? "justify-center" : "pl-8"}`}
    >
      <Image
        src="/logo.png"
        alt="Logo"
        width={28}
        height={28}
        className="h-auto w-auto"
      />
      <span className="text-base font-semibold">Archestra.AI</span>
    </div>
  );
}
