"use client";

import {
  type ArchestraToolShortName,
  getArchestraMcpCatalogName,
  getArchestraMcpServerName,
  getArchestraToolFullName,
  getArchestraToolShortName,
} from "@shared";
import { useMemo } from "react";
import appConfig from "@/lib/config/config";
import { useAppName } from "@/lib/hooks/use-app-name";

export function useArchestraMcpIdentity() {
  const appName = useAppName();
  const fullWhiteLabeling = appConfig.enterpriseFeatures.fullWhiteLabeling;

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
