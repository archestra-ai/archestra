import { WebClient } from "@slack/web-api";
import logger from "@/logging";
import {
  AgentChatOpsBotModel,
  ChatOpsBotModel,
  ChatOpsConfigModel,
  OrganizationModel,
} from "@/models";
import { ApiError, type ChatOpsConnectionMode } from "@/types";
import type { ChatOpsBot } from "@/types/chatops-bot";
import { chatOpsManager } from "./chatops-manager";
import { SLACK_DEFAULT_CONNECTION_MODE } from "./constants";
import { errorMessage } from "./utils";

/** What an admin can set on a Slack App; omitted fields keep their saved value. */
interface SlackAppSettings {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  signingSecret?: string;
  appId?: string;
  connectionMode?: ChatOpsConnectionMode;
  appLevelToken?: string;
}

/**
 * Slack App lifecycle: create, reconfigure, remove.
 *
 * An organization can run several Slack Apps. Each is one bot user token; a
 * display name is not an identity. After the first successful setup the app's
 * identity (workspace + bot user) is pinned, so a rotated token for the same
 * app is accepted while a token for another app is refused, and a token another
 * Slack App already uses is refused outright.
 */
class SlackAppService {
  /**
   * Create a Slack App, or (with `bot`) update an existing one. Returns the
   * saved bot once it is running.
   */
  async saveApp(params: {
    organizationId: string;
    /** The app being updated; omit to create a new one. */
    bot?: ChatOpsBot;
    /** Id for a new app, when the caller needs it before creation (webhook URLs). */
    newBotId?: string;
    settings: SlackAppSettings;
  }): Promise<ChatOpsBot> {
    const { organizationId, settings } = params;
    const existing = params.bot
      ? await ChatOpsConfigModel.getSlackConfig(params.bot)
      : null;

    // Merge new values with the saved config (or defaults for a first setup)
    const merged = {
      enabled: settings.enabled ?? existing?.enabled ?? false,
      botToken: settings.botToken ?? existing?.botToken ?? "",
      signingSecret: settings.signingSecret ?? existing?.signingSecret ?? "",
      appId: settings.appId ?? existing?.appId ?? "",
      connectionMode:
        settings.connectionMode ??
        existing?.connectionMode ??
        SLACK_DEFAULT_CONNECTION_MODE,
      appLevelToken: settings.appLevelToken ?? existing?.appLevelToken ?? "",
    };

    // Validate bot token by calling auth.test()
    let identity: SlackIdentity | null = null;
    if (merged.enabled && merged.botToken) {
      identity = await this.verifyBotToken(merged.botToken);
      await this.assertIdentityAllowed({
        organizationId,
        bot: params.bot,
        identity,
      });
    }

    // Validate app-level token for socket mode by calling apps.connections.open()
    if (
      merged.enabled &&
      merged.connectionMode === "socket" &&
      merged.appLevelToken
    ) {
      try {
        const client = new WebClient(merged.appLevelToken);
        await client.apps.connections.open();
      } catch {
        throw new ApiError(
          400,
          "Invalid Slack App-Level Token — could not open a Socket Mode connection. Please check your App-Level Token.",
        );
      }
    }

    const name = settings.name?.trim();
    const bot =
      params.bot ??
      (await ChatOpsBotModel.create({
        id: params.newBotId,
        organizationId,
        provider: "slack",
        name: name || (await OrganizationModel.getAppName()),
      }));
    if (params.bot && name && name !== bot.name) {
      await ChatOpsBotModel.update(bot.id, { name });
    }
    await ChatOpsConfigModel.saveSlackConfig({ bot, value: merged });

    try {
      await chatOpsManager.startSlackApp(bot.id);
    } catch (error) {
      throw new ApiError(
        400,
        `The Slack App was saved but could not start: ${errorMessage(error)}`,
      );
    }
    return (await ChatOpsBotModel.findById(bot.id)) ?? bot;
  }

  /**
   * Remove a Slack App: stop it, drop its channels and credentials. Refused
   * while any agent still uses it, so nothing an agent relies on disappears
   * silently.
   */
  async removeApp(params: {
    organizationId: string;
    botId: string;
  }): Promise<void> {
    const bot = await ChatOpsBotModel.findByIdAndOrganization(
      params.botId,
      params.organizationId,
    );
    if (!bot || bot.provider !== "slack") {
      throw new ApiError(404, "Slack App not found");
    }

    const agents = await AgentChatOpsBotModel.findAgentsByBot(bot.id);
    if (agents.length > 0) {
      throw new ApiError(
        409,
        `The Slack App "${bot.name}" is still used by ${agents
          .map((agent) => `"${agent.name}"`)
          .join(
            ", ",
          )}. Remove it from ${agents.length === 1 ? "that agent" : "those agents"} before removing the app.`,
      );
    }

    await chatOpsManager.stopSlackApp(bot.id);
    // Recorded before the row goes, so a restart can never re-seed the app.
    await ChatOpsConfigModel.disableSlackEnvSeeding();
    await ChatOpsBotModel.delete(bot.id);
    await ChatOpsConfigModel.deleteSlackConfig(bot).catch((error) => {
      logger.warn(
        { botId: bot.id, error: errorMessage(error) },
        "[SlackAppService] Could not delete the removed app's credentials",
      );
    });
  }

  private async verifyBotToken(botToken: string): Promise<SlackIdentity> {
    try {
      const client = new WebClient(botToken);
      const response = await client.auth.test();
      if (!response.user_id || !response.team_id) {
        throw new Error("auth.test did not return a bot identity");
      }
      return { botUserId: response.user_id, workspaceId: response.team_id };
    } catch {
      throw new ApiError(
        400,
        "Invalid Slack credentials — could not authenticate with Slack. Please check your Bot Token.",
      );
    }
  }

  private async assertIdentityAllowed(params: {
    organizationId: string;
    bot?: ChatOpsBot;
    identity: SlackIdentity;
  }): Promise<void> {
    const { bot, identity } = params;

    // A rotated token must still be the app this one was set up as.
    if (
      bot?.externalBotUserId &&
      (bot.externalBotUserId !== identity.botUserId ||
        bot.externalWorkspaceId !== identity.workspaceId)
    ) {
      throw new ApiError(
        400,
        `This Bot Token belongs to a different Slack app than "${bot.name}". Set up a new Slack App instead.`,
      );
    }

    const siblings = await ChatOpsBotModel.findByProvider({
      organizationId: params.organizationId,
      provider: "slack",
    });
    const holder = siblings.find(
      (sibling) =>
        sibling.id !== bot?.id &&
        sibling.externalBotUserId === identity.botUserId &&
        sibling.externalWorkspaceId === identity.workspaceId,
    );
    if (holder) {
      throw new ApiError(
        400,
        `This Bot Token is already used by the Slack App "${holder.name}".`,
      );
    }
  }
}

interface SlackIdentity {
  botUserId: string;
  workspaceId: string;
}

export const slackAppService = new SlackAppService();
