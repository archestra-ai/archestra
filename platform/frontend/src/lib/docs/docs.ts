import { type DocsPage, getDocsUrl, WEBSITE_URL } from "@shared";
import appConfig from "@/lib/config/config";

/**
 * Returns an Archestra docs URL unless full white-labeling is enabled, in
 * which case built-in docs links should be hidden from the frontend.
 */
export function getFrontendDocsUrl(
  page: DocsPage,
  anchor?: string,
): string | null {
  if (appConfig.enterpriseFeatures.fullWhiteLabeling) {
    return null;
  }

  return getDocsUrl(page, anchor);
}

/**
 * Returns the provided URL unless it points at the Archestra docs site while
 * full white-labeling is enabled. Third-party docs links are preserved.
 */
export function getVisibleDocsUrl(
  url: string | null | undefined,
): string | null {
  if (!url) {
    return null;
  }

  if (
    appConfig.enterpriseFeatures.fullWhiteLabeling &&
    url.startsWith(WEBSITE_URL)
  ) {
    return null;
  }

  return url;
}
