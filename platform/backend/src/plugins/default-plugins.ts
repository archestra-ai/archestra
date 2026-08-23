import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import logger from "@/logging";
import { MemberModel, OrganizationModel, PluginModel } from "@/models";
import { discoverGithubMarketplace } from "@/plugins/github-marketplace";
import { prepareGithubMarketplaceImports } from "@/plugins/github-marketplace-import";

const LEGACY_OPENAPPA_SOURCE_ID = "managed:openappa:claude-code";
const OPENAPPA_REPO = "archestra-ai/OpenAPPA";
const OPENAPPA_MARKETPLACE_PATH = ".claude-plugin/marketplace.json";
const OPENAPPA_MARKETPLACE_PLUGIN = "appa-runtime";
const OPENAPPA_TRACKING_REF = "main";
/** Release-reviewed bytes used only for the initial organization import. */
const OPENAPPA_PIN_SHA = "52906eb275a9f08106bfaf86a322f8b078be3dbd";

/**
 * Seed OpenAPPA once per organization as an ordinary GitHub marketplace
 * import. Existing and deleted marketplace identities are left alone, so
 * administrators own updates and deletion after the release seed runs.
 */
export async function seedDefaultPlugins(): Promise<void> {
  if (!config.plugins.enabled) return;

  const targets: Array<{
    organizationId: string;
    legacyPluginId: string | null;
  }> = [];
  for (const organizationId of await OrganizationModel.findAllIds()) {
    const existing = await PluginModel.findByMarketplaceIdentity({
      organizationId,
      marketplaceRepo: OPENAPPA_REPO,
      marketplacePath: OPENAPPA_MARKETPLACE_PATH,
      marketplacePluginName: OPENAPPA_MARKETPLACE_PLUGIN,
    });
    if (existing) {
      if (
        !existing.deletedAt &&
        existing.sourceId === LEGACY_OPENAPPA_SOURCE_ID
      ) {
        await PluginModel.normalizeDefaultGithubImport({
          id: existing.id,
          organizationId,
          sourceRef: OPENAPPA_TRACKING_REF,
          syncInterval: "1d",
        });
      }
      continue;
    }
    const legacy = await PluginModel.findBySourceId({
      organizationId,
      sourceId: LEGACY_OPENAPPA_SOURCE_ID,
    });
    targets.push({ organizationId, legacyPluginId: legacy?.id ?? null });
  }
  if (targets.length === 0) return;

  let prepared: Awaited<ReturnType<typeof prepareGithubMarketplaceImports>>;
  try {
    const advertised = await discoverGithubMarketplace({
      repoUrl: OPENAPPA_REPO,
      ref: OPENAPPA_PIN_SHA,
      marketplacePath: OPENAPPA_MARKETPLACE_PATH,
    });
    const entry = advertised.entries.find(
      (candidate) =>
        candidate.name === OPENAPPA_MARKETPLACE_PLUGIN && candidate.supported,
    );
    if (!entry?.sourceRepoUrl || !entry.sourceCommitSha || !entry.clientType) {
      throw new Error(
        `Default marketplace entry ${OPENAPPA_MARKETPLACE_PLUGIN} is unavailable`,
      );
    }
    prepared = await prepareGithubMarketplaceImports({
      repoUrl: OPENAPPA_REPO,
      ref: OPENAPPA_PIN_SHA,
      marketplacePath: OPENAPPA_MARKETPLACE_PATH,
      approvedCommitSha: OPENAPPA_PIN_SHA,
      trackingRef: OPENAPPA_PIN_SHA,
      reviewedSnapshot: advertised,
      selections: [
        {
          name: entry.name,
          displayName: "OpenAPPA",
          description: "Open Agent Policy Protocol integration for Claude Code",
          clientType: entry.clientType,
          supportedPlatforms: ["posix"],
          sourceRepoUrl: entry.sourceRepoUrl,
          sourceRef: OPENAPPA_PIN_SHA,
          sourceSubdir: entry.sourceSubdir,
          approvedSourceSha: entry.sourceCommitSha,
          exclude: [],
        },
      ],
    });
    if (prepared.failed.length > 0 || prepared.prepared.length !== 1) {
      throw new Error(
        prepared.failed[0]?.error ?? "Default marketplace import failed",
      );
    }
  } catch (error) {
    logger.warn(
      { err: error, source: OPENAPPA_REPO, pin: OPENAPPA_PIN_SHA },
      "Could not seed the default OpenAPPA plugin",
    );
    return;
  }
  const [{ imported }] = prepared.prepared;

  for (const { organizationId, legacyPluginId } of targets) {
    try {
      const members = await MemberModel.findAllByOrganization(organizationId);
      const approver = members.find(
        (member) => member.role === ADMIN_ROLE_NAME,
      );
      if (!approver) {
        logger.warn(
          { organizationId },
          "Skipped default OpenAPPA plugin: organization has no admin approver",
        );
        continue;
      }

      const source = {
        repo: imported.repo,
        ref: OPENAPPA_TRACKING_REF,
        sha: imported.commitSha,
        subdir: imported.subdir,
        exclude: [] as string[],
        marketplaceRepo: prepared.marketplace.repoUrl,
        marketplacePath: prepared.marketplace.path,
        marketplacePluginName: OPENAPPA_MARKETPLACE_PLUGIN,
      };
      if (legacyPluginId) {
        await PluginModel.update({
          id: legacyPluginId,
          organizationId,
          userId: approver.id,
          input: { files: imported.files },
          source,
        });
        await PluginModel.normalizeDefaultGithubImport({
          id: legacyPluginId,
          organizationId,
          sourceRef: OPENAPPA_TRACKING_REF,
          syncInterval: "1d",
        });
        continue;
      }

      const created = await PluginModel.create({
        organizationId,
        userId: approver.id,
        input: {
          displayName: "OpenAPPA",
          description: "Open Agent Policy Protocol integration for Claude Code",
          clientType: "claude-code",
          supportedPlatforms: ["posix"],
          scope: "org",
          files: imported.files,
        },
        source: {
          ...source,
          syncInterval: "1d",
          syncRef: OPENAPPA_TRACKING_REF,
        },
      });
      if (!created) {
        logger.warn(
          { organizationId },
          "Skipped default OpenAPPA plugin: marketplace identity is already in use",
        );
      }
    } catch (error) {
      logger.warn(
        { err: error, organizationId },
        "Could not seed default OpenAPPA plugin for organization",
      );
    }
  }
}
