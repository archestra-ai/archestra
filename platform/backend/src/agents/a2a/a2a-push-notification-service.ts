import logger from "@/logging";
import { A2APushNotificationConfigModel } from "@/models";
import { validateOutboundUrl } from "@/utils/outbound-url";
import type { A2AProtocolStreamResponse } from "./a2a-protocol";

/** A2A's media type for a pushed event body. */
const A2A_MEDIA_TYPE = "application/a2a+json";
const DELIVERY_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

/**
 * Delivers task stream events to a task's registered webhooks.
 *
 * Delivery is at-least-once and best-effort: the durable record is the task
 * and its event log, and the spec puts idempotency on the receiver (§13.2), so
 * a webhook that stays down costs the client its push updates but never the
 * task's outcome — GetTask and SubscribeToTask still tell the whole story.
 */
class A2APushNotificationService {
  /**
   * Fire the event at every webhook registered for the task. Never rejects:
   * callers invoke it from lifecycle paths that must not fail on a bad
   * endpoint.
   */
  async deliver(params: {
    taskId: string;
    event: A2AProtocolStreamResponse;
  }): Promise<void> {
    let targets: Awaited<
      ReturnType<typeof A2APushNotificationConfigModel.findDeliveryTargets>
    >;
    try {
      targets = await A2APushNotificationConfigModel.findDeliveryTargets(
        params.taskId,
      );
    } catch (error) {
      logger.warn(
        { error, taskId: params.taskId },
        "Failed to load A2A push notification configs",
      );
      return;
    }

    if (targets.length === 0) {
      return;
    }

    await Promise.all(
      targets.map((target) =>
        this.deliverToTarget({ target, event: params.event }).catch((error) => {
          logger.warn(
            { error, taskId: params.taskId, configId: target.id },
            "A2A push notification delivery failed",
          );
        }),
      ),
    );
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private async deliverToTarget(params: {
    target: {
      id: string;
      url: string;
      token: string | null;
      authScheme: string | null;
      authCredentials: string | null;
    };
    event: A2AProtocolStreamResponse;
  }): Promise<void> {
    const { target, event } = params;

    // Re-validate at send time: a config stored before a policy change, or a
    // URL whose host now resolves differently, must not become an egress hole.
    const validated = validateOutboundUrl(target.url);
    if (!validated.ok) {
      logger.warn(
        { configId: target.id, reason: validated.reason },
        "Refusing to deliver an A2A push notification to a disallowed URL",
      );
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": A2A_MEDIA_TYPE,
    };
    if (target.authScheme && target.authCredentials) {
      headers.Authorization = `${target.authScheme} ${target.authCredentials}`;
    }
    if (target.token) {
      headers["X-A2A-Notification-Token"] = target.token;
    }

    const body = JSON.stringify(event);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(validated.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
          // Never follow a redirect: it would take the caller's credentials
          // to a host that never passed validation.
          redirect: "manual",
        });

        if (response.ok) {
          return;
        }

        // 4xx (other than 429) is the receiver rejecting the payload; retrying
        // an unauthorized or malformed delivery just repeats the mistake.
        const retriable = response.status === 429 || response.status >= 500;
        if (!retriable || attempt === MAX_ATTEMPTS) {
          logger.warn(
            { configId: target.id, status: response.status, attempt },
            "A2A push notification rejected by the receiver",
          );
          return;
        }
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) {
          throw error;
        }
      }

      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}

export const a2aPushNotificationService = new A2APushNotificationService();

/**
 * Local development points webhooks at localhost, which the SSRF guard
 * otherwise refuses. Never enabled in production.
 */
function allowPrivateWebhookHosts(): boolean {
  return (
    process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "prod"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
