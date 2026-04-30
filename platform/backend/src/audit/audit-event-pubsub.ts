import pg from "pg";
import config from "@/config";
import logger from "@/logging";
import type { AuditEvent } from "@/types";

const AUDIT_EVENTS_CREATED_CHANNEL = "audit_events_created";

type CreatedHandler = (event: AuditEvent) => void;

class AuditEventPubsub {
  private client: pg.Client | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private handlers = new Set<CreatedHandler>();

  subscribeCreated(handler: CreatedHandler): () => void {
    this.handlers.add(handler);
    void this.ensureConnected();
    return () => {
      this.handlers.delete(handler);
      // Intentionally keep the listener connection alive; it is lightweight and
      // avoids reconnection churn when multiple SSE clients connect/disconnect.
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const client = new pg.Client({ connectionString: config.database.url });
        client.on("notification", (msg) => {
          if (msg.channel !== AUDIT_EVENTS_CREATED_CHANNEL) return;
          if (!msg.payload) return;

          const event = safeParseAuditEvent(msg.payload);
          if (!event) return;

          for (const handler of this.handlers) {
            try {
              handler(event);
            } catch (err) {
              logger.warn({ err }, "Audit event handler failed");
            }
          }
        });

        client.on("error", (err) => {
          logger.warn({ err }, "Audit pubsub client error");
          this.resetConnection();
        });

        await client.connect();
        await client.query(`LISTEN ${AUDIT_EVENTS_CREATED_CHANNEL}`);
        this.client = client;
        this.connected = true;
      } catch (err) {
        logger.warn({ err }, "Failed to connect audit pubsub client");
        this.resetConnection();
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  private resetConnection() {
    this.connected = false;
    this.connecting = null;
    if (this.client) {
      try {
        void this.client.end();
      } catch {
        // ignore
      }
    }
    this.client = null;
  }
}

export const auditEventPubsub = new AuditEventPubsub();

function safeParseAuditEvent(raw: string): AuditEvent | null {
  try {
    const parsed = JSON.parse(raw) as Omit<AuditEvent, "createdAt"> & {
      createdAt: string;
    };
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string") return null;
    if (typeof parsed.organizationId !== "string") return null;
    if (typeof parsed.action !== "string") return null;
    if (typeof parsed.resourceType !== "string") return null;
    if (typeof parsed.createdAt !== "string") return null;
    return {
      ...(parsed as unknown as AuditEvent),
      createdAt: new Date(parsed.createdAt),
    };
  } catch {
    return null;
  }
}
