"use client";

import {
  type ArchestraToolShortName,
  getArchestraMcpCatalogName,
  getArchestraMcpServerName,
  getArchestraToolFullName,
  getArchestraToolShortName,
} from "@shared";
import appConfig from "@/lib/config";
import { useAppName } from "@/lib/use-app-name";

export function useArchestraMcpIdentity() {
  const appName = useAppName();
  const options = {
    appName,
    fullWhiteLabeling: appConfig.enterpriseFeatures.fullWhiteLabeling,
  };

  return {
    appName,
    catalogName: getArchestraMcpCatalogName(options),
    serverName: getArchestraMcpServerName(options),
    getToolName(shortName: ArchestraToolShortName) {
      return getArchestraToolFullName(shortName, options);
    },
    getToolShortName(toolName: string) {
      return getArchestraToolShortName(toolName, {
        ...options,
        includeDefaultPrefix: true,
      });
    },
    isToolName(toolName: string) {
      return (
        getArchestraToolShortName(toolName, {
          ...options,
          includeDefaultPrefix: true,
        }) !== null
      );
    },
  };
}
