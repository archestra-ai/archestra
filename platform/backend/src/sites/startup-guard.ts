import { getAppVersion } from "@/app-version";
import config from "@/config";
import logger from "@/logging";
import { SiteModel } from "@/models";

/**
 * Refuse to start a secondary site whose version differs from the primary's.
 *
 * A secondary never migrates, so it runs against whatever schema the primary
 * applied. Code from another version reads and writes columns that schema may
 * not have (or no longer has), which fails far from its cause. Upgrade the
 * primary first, then each secondary to the same version.
 * ARCHESTRA_SITE_ALLOW_VERSION_SKEW=true accepts a deliberate mixed window.
 */
export async function assertSiteCanStart(): Promise<void> {
  if (config.site.role !== "secondary") return;
  const version = getAppVersion();
  const primary = (await SiteModel.findAll()).find(
    (site) => site.role === "primary",
  );
  const problem = !primary
    ? "no primary site is registered in the shared database (start or upgrade the primary first)"
    : primary.version !== version
      ? `the primary site "${primary.name}" runs ${primary.version} and this site runs ${version}`
      : null;
  if (!problem) return;
  if (config.site.allowVersionSkew) {
    logger.warn(
      { site: config.site.name, version },
      `Starting despite version skew: ${problem}. ARCHESTRA_SITE_ALLOW_VERSION_SKEW is set; unset it once every site runs the same version.`,
    );
    return;
  }
  throw new Error(
    `This secondary site cannot start: ${problem}. Every site sharing the database must run the primary's version; upgrade the primary first. Set ARCHESTRA_SITE_ALLOW_VERSION_SKEW=true to override.`,
  );
}
