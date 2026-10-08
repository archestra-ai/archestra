import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import { openappaDeclarations } from "@/openappa/declarations";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { parseDetectedServerId } from "@/utils/detected-mcp-server-names";

/**
 * The detected servers the policy's alias targets name. The root policy is
 * read on every call, but it is parsed once per revision: the proxy asks on
 * every request that declares tools.
 */
export async function declaredDetectedTargets(
  organizationId: string,
): Promise<ReadonlySet<string>> {
  if (!config.openappa.enabled) return new Set();
  const root = await guardrailsPolicyService.get(organizationId);
  const key = `${organizationId}\u0000${root.revision}\u0000${root.contentHash}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const targets = new Set(
    (await openappaDeclarations.aliasTargets(root.content)).filter(
      (target) => parseDetectedServerId(target) !== undefined,
    ),
  );
  cache.set(key, targets);
  return targets;
}

/**
 * The labels under which OpenCode spells a local tool `<label>_<tool>`: only
 * a declared `opencode.<label>` target can split such a name, so the targets
 * of one policy revision are the one source of them.
 */
export function openCodeLabelsOf(targets: Iterable<string>): string[] {
  return [...targets].flatMap((target) => {
    const id = parseDetectedServerId(target);
    return id?.family === "opencode" ? [id.label] : [];
  });
}

const cache = new LRUCacheManager<ReadonlySet<string>>({
  maxSize: 500,
  defaultTtl: 10 * 60_000,
});
