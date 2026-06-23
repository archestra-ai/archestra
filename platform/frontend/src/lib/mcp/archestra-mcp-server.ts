// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
"use client";

import {
  type ArchestraToolShortName,
  getArchestraMcpCatalogName,
  getArchestraMcpServerName,
  getArchestraToolFullName,
  getArchestraToolShortName,
} from "@archestra/shared";
import { useMemo } from "react";
import appConfig from "@/lib/config/config";
import { useAppName } from "@/lib/hooks/use-app-name";

export function useArchestraMcpIdentity() {
  const appName = useAppName();
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const fullWhiteLabeling = appConfig.enterpriseFeatures.fullWhiteLabeling;
  // SPDX-SnippetEnd

  return useMemo(() => {
    const options = {
      appName,
      fullWhiteLabeling,
    };

    const getToolShortName = (toolName: string) =>
      getArchestraToolShortName(toolName, {
        ...options,
        includeDefaultPrefix: true,
      });

    return {
      appName,
      catalogName: getArchestraMcpCatalogName(options),
      serverName: getArchestraMcpServerName(options),
      getToolName(shortName: ArchestraToolShortName) {
        return getArchestraToolFullName(shortName, options);
      },
      getToolShortName,
      isToolName(toolName: string) {
        return getToolShortName(toolName) !== null;
      },
    };
  }, [appName, fullWhiteLabeling]);
}
