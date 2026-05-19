"use client";

import Image from "next/image";
import { useTheme } from "next-themes";
import config from "@/lib/config/config";
import { DEFAULT_APP_LOGO } from "@/lib/hooks/use-app-name";
import { useOrgTheme } from "@/lib/theme.hook";

const APP_DISPLAY_NAME = "Archestra.AI";

export function AppLogo() {
  const { logo, logoDark, isLoadingAppearance } = useOrgTheme() ?? {};
  const { resolvedTheme } = useTheme();
  const effectiveLogo = resolvedTheme === "dark" && logoDark ? logoDark : logo;

  if (isLoadingAppearance) {
    return <div className="h-[47px]" aria-hidden="true" />;
  }

  if (effectiveLogo) {
    return (
      <div className="flex justify-center">
        <div className="flex flex-col items-center gap-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={effectiveLogo}
            alt="Organization logo"
            width={200}
            height={60}
            className="object-contain max-w-full max-h-12 w-auto h-auto"
          />
          {!config.enterpriseFeatures.fullWhiteLabeling && (
            <p className="text-[10px] text-muted-foreground">
              Powered by {APP_DISPLAY_NAME}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-2">
        <Image
          src={DEFAULT_APP_LOGO}
          alt="Logo"
          width={28}
          height={28}
          className="size-7 shrink-0"
        />
        <span className="text-base font-semibold">{APP_DISPLAY_NAME}</span>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Open Source AI Platform
      </p>
    </div>
  );
}
