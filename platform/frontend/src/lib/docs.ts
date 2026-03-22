import { type DocsPage, getDocsUrl } from "@shared";
import appConfig from "@/lib/config";

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
