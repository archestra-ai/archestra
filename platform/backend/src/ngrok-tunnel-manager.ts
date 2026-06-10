import type { Listener } from "@ngrok/ngrok";
import * as ngrok from "@ngrok/ngrok";
import config from "@/config";
import logger from "@/logging";
import ChatOpsConfigModel from "@/models/chatops-config";
import type { NgrokDbConfig } from "@/types";

/**
 * Brings up an ngrok tunnel in-process so an Archestra instance is reachable
 * from the Internet — required for inbound chatops webhooks (MS Teams, Slack)
 * when running locally or behind NAT.
 *
 * Replaces the previous CLI-based setup (an ngrok binary downloaded at runtime
 * and supervised separately, plus a polling script that wrote the assigned
 * domain to disk). The tunnel now runs via the ngrok agent SDK and the public
 * domain is held in memory and served through `GET /api/config`.
 *
 * The auth token is persisted as a DB secret (via {@link ChatOpsConfigModel}),
 * so `start()` can bring the tunnel up live — no env var or restart needed — and
 * `initialize()` reconnects it on the next boot. An `ARCHESTRA_NGROK_AUTH_TOKEN`
 * env var seeds the same flow for non-interactive deployments.
 */
class NgrokTunnelManager {
  private listener: Listener | null = null;
  private publicDomain = "";

  /**
   * The public domain (host, without scheme) the instance is reachable at, or
   * "" when no tunnel is configured. A reserved domain is known up-front; an
   * ephemeral domain is filled in once the tunnel connects.
   */
  getPublicDomain(): string {
    return this.publicDomain;
  }

  /**
   * Boot-time: connect using the persisted config, falling back to the env var.
   * A failure here must not take down the web server.
   */
  async initialize(): Promise<void> {
    const resolved = await this.resolveConfig();
    if (!resolved?.authToken) return;

    try {
      await this.connect(resolved.authToken, resolved.domain);
    } catch (error) {
      logger.error(
        { err: error },
        "Failed to establish ngrok tunnel on startup",
      );
    }
  }

  /**
   * Persist new credentials and (re)connect the tunnel live. Returns the public
   * domain. Throws if the tunnel cannot be established, leaving no tunnel and no
   * persisted credentials — so the caller can surface the error to the user.
   */
  async start(params: { authToken: string; domain?: string }): Promise<string> {
    const domain = params.domain?.trim() ?? "";

    try {
      await this.connect(params.authToken, domain);
    } catch (error) {
      await this.disconnect();
      throw error;
    }

    await ChatOpsConfigModel.saveNgrokConfig({
      authToken: params.authToken,
      domain,
      enabled: true,
    });
    return this.publicDomain;
  }

  /**
   * Tear down the tunnel and mark the config disabled. Credentials are kept so
   * a later reconnect can reuse them, but the disabled marker prevents
   * `initialize()` (and the env var) from bringing the tunnel back on restart.
   */
  async stop(): Promise<void> {
    await this.disconnect();
    const stored = await ChatOpsConfigModel.getNgrokConfig().catch(() => null);
    await ChatOpsConfigModel.saveNgrokConfig({
      authToken: stored?.authToken ?? "",
      domain: stored?.domain ?? "",
      enabled: false,
    });
  }

  /** Close the active tunnel on shutdown, keeping persisted credentials. */
  async cleanup(): Promise<void> {
    await this.disconnect();
  }

  private async resolveConfig(): Promise<NgrokDbConfig | null> {
    // DB config (set via the UI) takes precedence; the env var seeds the
    // initial value for non-interactive deployments.
    const dbConfig = await ChatOpsConfigModel.getNgrokConfig().catch(
      (error) => {
        logger.warn({ err: error }, "Failed to read ngrok config from DB");
        return null;
      },
    );
    if (dbConfig) {
      // An explicit stop must stick across restarts — don't fall through to
      // the env var either, or it would resurrect a tunnel the user shut down.
      if (dbConfig.enabled === false) return null;
      if (dbConfig.authToken) return dbConfig;
    }

    const { authToken, domain } = config.ngrok;
    return authToken ? { authToken, domain } : null;
  }

  private async connect(authToken: string, domain: string): Promise<void> {
    await this.disconnect();

    // A reserved domain is known before the tunnel connects, so surface it
    // immediately — the public URL stays available even if connect is slow.
    if (domain) this.publicDomain = domain;

    this.listener = await ngrok.forward({
      // Forward to the backend API port so chatops webhooks
      // (`/api/webhooks/...`) are reachable directly.
      addr: config.api.port,
      authtoken: authToken,
      ...(domain ? { domain } : {}),
    });
    const url = this.listener.url();
    if (url) this.publicDomain = url.replace(/^https?:\/\//, "");
    logger.info({ url }, "ngrok tunnel established");
  }

  private async disconnect(): Promise<void> {
    if (this.listener) {
      try {
        await this.listener.close();
      } catch (error) {
        logger.warn({ err: error }, "Error closing ngrok tunnel");
      }
      this.listener = null;
    }
    this.publicDomain = "";
  }
}

export const ngrokTunnelManager = new NgrokTunnelManager();
