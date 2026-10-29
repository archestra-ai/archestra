import RoutingPlanModel from "@/models/routing-plan";
import { type ConfigCache, configCache } from "@/services/config-cache";
import type { RoutingPlan } from "@/types/auto-routing";

/**
 * Each organization's serving plan, read through the proxy configuration
 * cache: `routing_plans` writes notify its channel, and its TTL bounds how
 * long a lost notification can keep a superseded plan in use. The returned
 * plan is shared between requests and must not be mutated.
 * @public — exported for testability (one instance per simulated replica)
 */
export class RoutingPlanCache {
  constructor(private readonly cache: ConfigCache) {}

  findActive(organizationId: string): Promise<RoutingPlan | null> {
    return this.cache.read(`routing-plan\0${organizationId}`, () =>
      RoutingPlanModel.findActive(organizationId),
    );
  }
}

/** @public — the process-wide cache the auto-routing request path reads */
export const routingPlanCache = new RoutingPlanCache(configCache);
