// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
"use client";

import Image from "next/image";
import { useTheme } from "next-themes";
import config from "@/lib/config/config";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrgTheme } from "@/lib/theme.hook";

// white-label-ok: default brand mark, shown only when no white-label logo is configured
const APP_DISPLAY_NAME = "Archestra.AI";
const DEFAULT_APP_WORDMARK = "/logo.svg";

export function AppLogo() {
  const appName = useAppName();
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
            alt={`${appName} logo`}
            width={200}
            height={60}
            className="object-contain max-w-full max-h-12 w-auto h-auto"
          />
          {/* SPDX-SnippetBegin */}
          {/* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */}
          {/* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
          {!config.enterpriseFeatures.fullWhiteLabeling && (
            <p className="text-[10px] text-muted-foreground">
              Powered by {APP_DISPLAY_NAME}
            </p>
          )}
          {/* SPDX-SnippetEnd */}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      {/* The wordmark is drawn in near-black, so invert it for dark mode. */}
      <Image
        src={DEFAULT_APP_WORDMARK}
        alt={APP_DISPLAY_NAME}
        width={138}
        height={24}
        className="h-6 w-auto shrink-0 dark:invert"
      />
      <p className="text-[10px] text-muted-foreground">Secure AI Platform</p>
    </div>
  );
}
