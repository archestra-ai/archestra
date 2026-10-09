import { createHash, randomUUID } from "node:crypto";
import {
  buildSlackManifest,
  migrateSlackManifest,
  slackHandleFor,
  TimeInMs,
} from "@archestra/shared";
import { WebClient } from "@slack/web-api";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, ChatOpsConfigModel, OrganizationModel } from "@/models";
import { ngrokTunnelManager } from "@/ngrok-tunnel-manager";
import type {
  ChatOpsConnectionMode,
  SlackAgentBotConfig,
  SlackAppConfigToken,
  SlackAppMigrationResult,
} from "@/types";
import { errorMessage } from "./utils";

/**
 * Creates the Slack app for an agent bot with Slack's App Manifest API, so an
 * admin does not copy a manifest by hand.
 *
 * Two Slack rules shape the flow:
 * - Creating an app needs an app configuration token. An admin pastes it once;
 *   it expires every 12 hours and is renewed here with its refresh token.
 * - Installing an app needs a person to approve it, through an OAuth redirect
 *   that Slack only accepts over HTTPS. With an HTTPS public URL (a real domain
 *   or ngrok) the install is one click and the bot token arrives on its own;
 *   without one, the admin installs from the app's Slack page and pastes the
 *   bot token.
 *
 * Socket Mode also needs an app-level token, which Slack has no API to create,
 * so that one is always pasted.
 */
class SlackAppFactory {
  /** Validate and store an app configuration token pair. */
  async saveConfigToken(params: {
    accessToken: string;
    refreshToken: string;
  }): Promise<void> {
    // Rotating right away proves the refresh token works and yields a token
    // with a known expiry; the pasted access token's age is unknown.
    await this.rotate(params.refreshToken);
    logger.info("[SlackAppFactory] Saved a Slack app configuration token");
  }

  async hasConfigToken(): Promise<boolean> {
    return (await ChatOpsConfigModel.getSlackAppConfigToken()) !== null;
  }

  /** Whether an app can be installed with one click (OAuth over HTTPS). */
  canInstallWithOAuth(): boolean {
    return this.publicBaseUrl().startsWith("https://");
  }

  /**
   * Create the Slack app for an agent bot and save it, not yet installed.
   * Returns where the admin goes next to install it.
   */
  async createAgentApp(params: {
    agentId: string;
    appName: string;
    connectionMode: ChatOpsConnectionMode;
    organizationId: string;
  }): Promise<{
    appId: string;
    installUrl: string;
    installMode: "oauth" | "manual";
  }> {
    const token = await this.getAccessToken();
    const base = this.publicBaseUrl();
    const webhookBase = `${base}/api/webhooks/chatops/slack/agents/${params.agentId}`;
    const oauth = this.canInstallWithOAuth();
    const manifest = JSON.parse(
      buildSlackManifest({
        appName: params.appName,
        connectionMode: params.connectionMode,
        webhookUrl: webhookBase,
        interactiveUrl: `${webhookBase}/interactive`,
        slashCommandUrl: "",
        slashCommands: false,
        ...(oauth && { redirectUrls: [this.callbackUrl()] }),
      }),
    );

    const created = await new WebClient().apps.manifest.create({
      token,
      manifest,
    });
    const appId = created.app_id;
    const credentials = created.credentials;
    if (!created.ok || !appId || !credentials?.signing_secret) {
      throw new Error(created.error ?? "Slack did not return the new app");
    }

    // A handle left at its default keeps following the agent's name.
    const agent = await AgentModel.findById(params.agentId);
    const handleFollowsAgent =
      Boolean(agent) &&
      params.appName ===
        slackHandleFor(await OrganizationModel.getAppName(), agent?.name ?? "");

    // Saved disabled until installed: there is no bot token yet.
    await ChatOpsConfigModel.saveSlackAgentBot({
      agentId: params.agentId,
      enabled: false,
      botToken: "",
      signingSecret: credentials.signing_secret,
      appId,
      connectionMode: params.connectionMode,
      appLevelToken: "",
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret,
      managed: true,
      handleFollowsAgent,
      ...(agent && { syncedAgentName: agent.name }),
    });
    logger.info(
      { agentId: params.agentId, appId },
      "[SlackAppFactory] Created a Slack app for an agent bot",
    );
    // The agent's icon becomes the app's icon.
    await this.syncAgentIdentity(params.agentId);

    if (!oauth || !created.oauth_authorize_url) {
      return {
        appId,
        installUrl: `https://api.slack.com/apps/${appId}/oauth`,
        installMode: "manual",
      };
    }

    const state = randomUUID();
    await cacheManager.set(
      installStateKey(state),
      { agentId: params.agentId, organizationId: params.organizationId },
      INSTALL_STATE_TTL_MS,
    );
    const installUrl = new URL(created.oauth_authorize_url);
    installUrl.searchParams.set("redirect_uri", this.callbackUrl());
    installUrl.searchParams.set("state", state);
    return { appId, installUrl: installUrl.toString(), installMode: "oauth" };
  }

  /**
   * Finish a one-click install: exchange Slack's code for the bot token and
   * enable the bot. `state` must be one this server issued, and is used once.
   */
  async completeOAuthInstall(params: {
    code: string;
    state: string;
  }): Promise<{ agentId: string }> {
    const key = installStateKey(params.state);
    const pending = await cacheManager.get<{ agentId: string }>(key);
    if (!pending) {
      throw new Error("This install link expired. Start again from Archestra.");
    }
    await cacheManager.delete(key);

    const bot = (await ChatOpsConfigModel.getSlackAgentBots()).find(
      (candidate) => candidate.agentId === pending.agentId,
    );
    if (!bot?.clientId || !bot.clientSecret) {
      throw new Error("This agent's Slack app is no longer set up.");
    }

    const access = await new WebClient().oauth.v2.access({
      client_id: bot.clientId,
      client_secret: bot.clientSecret,
      code: params.code,
      redirect_uri: this.callbackUrl(),
    });
    if (!access.ok || !access.access_token) {
      throw new Error(access.error ?? "Slack did not return a bot token");
    }

    await ChatOpsConfigModel.saveSlackAgentBot({
      ...bot,
      botToken: access.access_token,
      enabled: true,
    });
    return { agentId: pending.agentId };
  }

  /**
   * Delete from Slack an app Archestra created. Best effort: the bot is
   * disconnected either way, and an app someone created by hand is left alone.
   */
  async deleteCreatedApp(bot: SlackAgentBotConfig): Promise<void> {
    if (!(bot.managed || bot.clientId) || !bot.appId) return;
    try {
      const token = await this.getAccessToken();
      await new WebClient().apps.manifest.delete({ token, app_id: bot.appId });
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), appId: bot.appId },
        "[SlackAppFactory] Could not delete the Slack app; it stays in Slack",
      );
    }
  }

  /**
   * Bring every connected Slack app — the main app and each agent bot set up
   * by hand — up to the settings an app Archestra creates gets: the agent
   * experience (Stop button, streaming, suggested prompts) and the current
   * events and scopes. From then on Archestra manages them like apps it
   * created. Each app is patched, not replaced, so its name, icon, and URLs
   * stay. Slack cannot switch an app back from the agent experience.
   */
  async migrateExistingApps(): Promise<SlackAppMigrationResult[]> {
    const token = await this.getAccessToken();
    const main = await ChatOpsConfigModel.getSlackConfig();
    const bots = await ChatOpsConfigModel.getSlackAgentBots();
    const targets: { appId: string; bot?: SlackAgentBotConfig }[] = [
      ...(main?.appId ? [{ appId: main.appId }] : []),
      ...bots.flatMap((bot) => (bot.appId ? [{ appId: bot.appId, bot }] : [])),
    ];

    const results: SlackAppMigrationResult[] = [];
    for (const target of targets) {
      const agentId = target.bot?.agentId;
      try {
        const client = new WebClient();
        const exported = await client.apps.manifest.export({
          token,
          app_id: target.appId,
        });
        if (!exported.manifest) {
          throw new Error(exported.error ?? "Slack returned no manifest");
        }
        const updated = await client.apps.manifest.update({
          token,
          app_id: target.appId,
          // Slack's own export, patched: it is a valid manifest by construction.
          manifest: migrateSlackManifest(
            exported.manifest as Record<string, unknown>,
          ) as unknown as Parameters<
            WebClient["apps"]["manifest"]["update"]
          >[0]["manifest"],
        });
        if (target.bot) {
          await ChatOpsConfigModel.saveSlackAgentBot({
            ...target.bot,
            managed: true,
          });
        }
        results.push({
          appId: target.appId,
          ...(agentId && { agentId }),
          ok: true,
          ...(updated.permissions_updated && {
            reinstallUrl: `https://api.slack.com/apps/${target.appId}/oauth`,
          }),
        });
      } catch (error) {
        logger.warn(
          { error: errorMessage(error), appId: target.appId },
          "[SlackAppFactory] Could not migrate a Slack app",
        );
        results.push({
          appId: target.appId,
          ...(agentId && { agentId }),
          ok: false,
          error: errorMessage(error),
        });
      }
    }
    return results;
  }

  /**
   * Point an existing app at one agent, as if Archestra had created it for that
   * agent: the agent experience, its own webhook URLs, and no slash commands
   * (those route to whichever agent a channel picks). Returns whether Slack
   * wants it reinstalled for changed scopes.
   */
  async retargetAppToAgent(params: {
    appId: string;
    agentId: string;
    connectionMode: ChatOpsConnectionMode;
  }): Promise<{ reinstallUrl?: string }> {
    const token = await this.getAccessToken();
    const client = new WebClient();
    const exported = await client.apps.manifest.export({
      token,
      app_id: params.appId,
    });
    if (!exported.manifest) {
      throw new Error(exported.error ?? "Slack returned no manifest");
    }

    const manifest = migrateSlackManifest(
      exported.manifest as Record<string, unknown>,
    ) as {
      features?: Record<string, unknown>;
      settings?: {
        event_subscriptions?: Record<string, unknown>;
        interactivity?: Record<string, unknown>;
      };
    };
    if (manifest.features) delete manifest.features.slash_commands;
    if (params.connectionMode === "webhook" && manifest.settings) {
      const webhookBase = `${this.publicBaseUrl()}/api/webhooks/chatops/slack/agents/${params.agentId}`;
      manifest.settings.event_subscriptions = {
        ...manifest.settings.event_subscriptions,
        request_url: webhookBase,
      };
      manifest.settings.interactivity = {
        ...manifest.settings.interactivity,
        is_enabled: true,
        request_url: `${webhookBase}/interactive`,
      };
    }

    const updated = await client.apps.manifest.update({
      token,
      app_id: params.appId,
      // Slack's own export, patched: it is a valid manifest by construction.
      manifest: manifest as unknown as Parameters<
        WebClient["apps"]["manifest"]["update"]
      >[0]["manifest"],
    });
    return updated.permissions_updated
      ? { reinstallUrl: `https://api.slack.com/apps/${params.appId}/oauth` }
      : {};
  }

  /**
   * Keep a managed bot looking like its agent: the agent's icon as the app
   * icon and, while the handle follows the agent, the agent's name as the
   * bot's name. Compares against what it last applied, so calling it after
   * any agent edit is cheap and a no-op when nothing relevant changed. Never
   * throws: a refusal is saved on the bot for the settings page to show.
   */
  async syncAgentIdentity(agentId: string): Promise<void> {
    try {
      const bot = (await ChatOpsConfigModel.getSlackAgentBots()).find(
        (candidate) => candidate.agentId === agentId,
      );
      if (!bot?.appId || !(bot.managed || bot.clientId)) return;
      if (!(await this.hasConfigToken())) return;
      const agent = await AgentModel.findById(agentId);
      if (!agent) return;

      const renameTo =
        bot.handleFollowsAgent && agent.name !== bot.syncedAgentName
          ? slackHandleFor(await OrganizationModel.getAppName(), agent.name)
          : null;
      const icon = parseImageDataUrl(agent.icon);
      const iconHash = icon
        ? createHash("sha256")
            .update(agent.icon ?? "")
            .digest("hex")
        : undefined;
      const updateIcon = Boolean(icon) && iconHash !== bot.syncedIconHash;
      if (!renameTo && !updateIcon) return;

      const token = await this.getAccessToken();
      const errors: string[] = [];
      let syncedAgentName = bot.syncedAgentName;
      let syncedIconHash = bot.syncedIconHash;

      if (renameTo) {
        try {
          await this.renameApp({ token, appId: bot.appId, name: renameTo });
          syncedAgentName = agent.name;
        } catch (error) {
          errors.push(`Name: ${errorMessage(error)}`);
        }
      }
      if (icon && updateIcon) {
        try {
          await this.setAppIcon({ token, appId: bot.appId, icon });
          syncedIconHash = iconHash;
        } catch (error) {
          errors.push(`Icon: ${errorMessage(error)}`);
        }
      }

      const latest = (await ChatOpsConfigModel.getSlackAgentBots()).find(
        (candidate) => candidate.agentId === agentId,
      );
      if (!latest) return;
      await ChatOpsConfigModel.saveSlackAgentBot({
        ...latest,
        ...(syncedAgentName && { syncedAgentName }),
        ...(syncedIconHash && { syncedIconHash }),
        identitySyncError: errors.length > 0 ? errors.join(" · ") : undefined,
      });
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), agentId },
        "[SlackAppFactory] Could not sync the bot's name or icon",
      );
    }
  }

  /** Where Slack sends the browser back after an install. */
  callbackUrl(): string {
    return `${this.publicBaseUrl()}/api/webhooks/chatops/slack/oauth/callback`;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /** A live configuration token, renewed when it is close to expiring. */
  private async getAccessToken(): Promise<string> {
    const saved = await ChatOpsConfigModel.getSlackAppConfigToken();
    if (!saved) {
      throw new Error(
        "Add a Slack app configuration token so Archestra can create Slack apps.",
      );
    }
    if (saved.expiresAt - Date.now() > ROTATE_BEFORE_EXPIRY_MS) {
      return saved.accessToken;
    }
    return (await this.rotate(saved.refreshToken)).accessToken;
  }

  /** Set the app's name and its bot's name, which is also its @handle. */
  private async renameApp(params: {
    token: string;
    appId: string;
    name: string;
  }): Promise<void> {
    const client = new WebClient();
    const exported = await client.apps.manifest.export({
      token: params.token,
      app_id: params.appId,
    });
    if (!exported.manifest) {
      throw new Error(exported.error ?? "Slack returned no manifest");
    }
    const manifest = exported.manifest as {
      display_information?: Record<string, unknown>;
      features?: { bot_user?: Record<string, unknown> };
    };
    manifest.display_information = {
      ...manifest.display_information,
      name: params.name,
    };
    manifest.features = {
      ...manifest.features,
      bot_user: { ...manifest.features?.bot_user, display_name: params.name },
    };
    await client.apps.manifest.update({
      token: params.token,
      app_id: params.appId,
      manifest: manifest as unknown as Parameters<
        WebClient["apps"]["manifest"]["update"]
      >[0]["manifest"],
    });
  }

  /** Upload an image as the app's icon (Slack's apps.icon.set). */
  private async setAppIcon(params: {
    token: string;
    appId: string;
    icon: { contentType: string; data: Buffer };
  }): Promise<void> {
    const extension = params.icon.contentType.split("/")[1] ?? "png";
    // A `name` on the buffer gives the multipart upload its filename.
    const file = Object.assign(params.icon.data, {
      name: `icon.${extension.replace(/\+.*$/, "")}`,
    });
    const result = await new WebClient().apiCall("apps.icon.set", {
      token: params.token,
      app_id: params.appId,
      file,
    });
    if (!result.ok) {
      throw new Error(result.error ?? "Slack refused the icon");
    }
  }

  private async rotate(refreshToken: string): Promise<SlackAppConfigToken> {
    const rotated = await new WebClient().tooling.tokens.rotate({
      refresh_token: refreshToken,
    });
    if (!rotated.ok || !rotated.token || !rotated.refresh_token) {
      throw new Error(rotated.error ?? "Slack did not renew the token");
    }
    const token = {
      accessToken: rotated.token,
      // Each rotation issues a new refresh token; the old one stops working.
      refreshToken: rotated.refresh_token,
      expiresAt: rotated.exp
        ? rotated.exp * 1000
        : Date.now() + CONFIG_TOKEN_LIFETIME_MS,
    };
    await ChatOpsConfigModel.saveSlackAppConfigToken(token);
    return token;
  }

  /** The URL Slack reaches this server at, as the setup wizard shows it. */
  private publicBaseUrl(): string {
    const ngrokDomain = ngrokTunnelManager.getPublicDomain();
    if (ngrokDomain) {
      return `https://${ngrokDomain.replace(/^https?:\/\//, "")}`;
    }
    return config.frontendBaseUrl.replace(/\/$/, "");
  }
}

export const slackAppFactory = new SlackAppFactory();

// =============================================================================
// Internal Helpers
// =============================================================================

/** Renew a configuration token this long before Slack expires it. */
const ROTATE_BEFORE_EXPIRY_MS = 10 * TimeInMs.Minute;

const CONFIG_TOKEN_LIFETIME_MS = 12 * TimeInMs.Hour;

/** Slack's authorization code lives 10 minutes; the link a little longer. */
const INSTALL_STATE_TTL_MS = 30 * TimeInMs.Minute;

/**
 * An agent icon that Slack can use: an uploaded image (a base64 data URL).
 * An emoji icon is not an image file, so it has no Slack app icon.
 */
function parseImageDataUrl(
  icon: string | null | undefined,
): { contentType: string; data: Buffer } | null {
  const match = icon?.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return null;
  return { contentType: match[1], data: Buffer.from(match[2], "base64") };
}

function installStateKey(state: string): AllowedCacheKey {
  return `${CacheKey.SlackAppInstallState}-${state}` as AllowedCacheKey;
}
