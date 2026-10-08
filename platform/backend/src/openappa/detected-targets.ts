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
 * The detected targets an included battery's namespaces bind, with the root
 * revision they were read at: the only detected targets a composition can
 * derive an install row for. A target only a hand-written rule names needs
 * no row, so no recompose waits on it. Resolved once per revision.
 */
export async function batteryBackedDetectedTargets(
  organizationId: string,
): Promise<{ revision: number; targets: ReadonlySet<string> }> {
  if (!config.openappa.enabled) return { revision: 0, targets: new Set() };
  const root = await guardrailsPolicyService.get(organizationId);
  const key = `${organizationId}\u0000${root.revision}\u0000${root.contentHash}`;
  const cached = backedCache.get(key);
  if (cached) return { revision: root.revision, targets: cached };
  const resolution = await openappaDeclarations.resolve({
    organizationId,
    content: root.content,
  });
  const namespaces = new Set(
    resolution.entries.flatMap((entry) => entry.battery?.namespaces ?? []),
  );
  const targets = new Set(
    resolution.aliases
      .filter((alias) => namespaces.has(alias.namespace))
      .flatMap((alias) => alias.servers)
      .filter((target) => parseDetectedServerId(target) !== undefined),
  );
  backedCache.set(key, targets);
  return { revision: root.revision, targets };
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

const backedCache = new LRUCacheManager<ReadonlySet<string>>({
  maxSize: 500,
  defaultTtl: 10 * 60_000,
});
