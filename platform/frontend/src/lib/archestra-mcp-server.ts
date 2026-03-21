"use client";

import {
  type ArchestraToolShortName,
  type DocsPage,
  getArchestraMcpCatalogName,
  getArchestraMcpServerName,
  getArchestraToolFullName,
  getArchestraToolShortName,
  getDocsUrl,
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

export function getFrontendDocsUrl(
  page: DocsPage,
  anchor?: string,
): string | null {
  if (appConfig.enterpriseFeatures.fullWhiteLabeling) {
    return null;
  }

  return getDocsUrl(page, anchor);
}

export function getVisibleDocsUrl(
  url: string | null | undefined,
): string | null {
  if (!url) {
    return null;
  }

  if (
    appConfig.enterpriseFeatures.fullWhiteLabeling &&
    url.startsWith("https://archestra.ai/")
  ) {
    return null;
  }

  return url;
}
