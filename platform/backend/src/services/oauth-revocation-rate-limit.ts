import {
  RateLimiterCompatibleAbstract,
  RateLimiterRes,
} from "rate-limiter-flexible";
import { oauthTokenRateLimiter } from "./oauth-token-rate-limit";

/** Standard limiter interface over issuance's existing atomic, shared budget. */
class OAuthRevocationRateLimiter extends RateLimiterCompatibleAbstract {
  override async consume(
    key: string | number,
    points = 1,
    options?: Record<string, unknown>,
  ): Promise<RateLimiterRes> {
    // The shared policy charges one request and owns its window/key namespace.
    // Reject unsupported overrides instead of silently splitting that budget.
    if (
      typeof key !== "string" ||
      points !== 1 ||
      (options && Object.keys(options).length)
    ) {
      throw new Error(
        "OAuth rate limiting requires one request without overrides",
      );
    }
    const limit = await oauthTokenRateLimiter.consume(key);
    const result = new RateLimiterRes(
      Math.max(0, oauthTokenRateLimiter.max - limit.current),
      limit.ttl,
      limit.current,
      limit.current === 1,
    );
    if (!limit.allowed) throw result;
    return result;
  }
}

export const oauthRevocationRateLimiter = new OAuthRevocationRateLimiter();
