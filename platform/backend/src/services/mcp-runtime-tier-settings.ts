import {
  ApiError,
  findMcpRuntimeTier,
  type McpRuntimeTierSettings,
  type McpRuntimeTierSettingsInput,
  ResolvedMcpRuntimeTiersSchema,
  resolveMcpRuntimeTiers,
} from "@archestra/shared";
import type { Transaction } from "@/database";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import OrganizationModel from "@/models/organization";

export async function organizationMcpRuntimeTiers(
  organizationId: string,
  tx?: Transaction,
) {
  const organization = await OrganizationModel.getById(organizationId, tx);
  return resolveMcpRuntimeTiers(organization?.mcpRuntimeTiers);
}

export async function prepareMcpRuntimeTierChange(params: {
  organizationId: string;
  input: McpRuntimeTierSettingsInput | null;
  tx: Transaction;
}): Promise<{
  settings: McpRuntimeTierSettings | null;
  write: (tx: Transaction) => Promise<void>;
}> {
  const { organizationId, input, tx } = params;
  // Readers and reference writers serialize on this same organization row.
  await OrganizationModel.lockRowForUpdate(organizationId, tx);
  const current = await organizationMcpRuntimeTiers(organizationId, tx);
  const explicitlyMapped = new Set(
    input?.tiers.flatMap((tier) =>
      tier.previousName ? [tier.previousName.toLowerCase()] : [],
    ),
  );
  const candidates = input?.tiers ?? resolveMcpRuntimeTiers(null).tiers;
  const renames = candidates.flatMap((tier) => {
    const previousName = "previousName" in tier ? tier.previousName : undefined;
    const before = findMcpRuntimeTier(current.tiers, previousName ?? tier.name);
    if (previousName && !before)
      throw new ApiError(400, `Unknown previous MCP tier ${previousName}`);
    // A name reused after an explicit rename is a new tier, not a second
    // mapping for the same original tier (even if its casing differs).
    if (
      !previousName &&
      before &&
      explicitlyMapped.has(before.name.toLowerCase())
    )
      return [];
    return before && before.name !== tier.name
      ? [{ from: before.name, to: tier.name }]
      : [];
  });
  const renamedAway = new Set(
    renames.map((rename) => rename.from.toLowerCase()),
  );
  const settings: McpRuntimeTierSettings | null = input
    ? {
        tiers: input.tiers.map(({ previousName, ...tier }) => {
          const reusesRenamedName =
            !previousName &&
            renames.some(
              (rename) =>
                rename.from.toLowerCase() === tier.name.toLowerCase() &&
                rename.to.toLowerCase() !== tier.name.toLowerCase(),
            );
          const before = reusesRenamedName
            ? undefined
            : findMcpRuntimeTier(current.tiers, previousName ?? tier.name);
          return {
            ...tier,
            memoryRequestMiB:
              tier.memoryRequestMiB === undefined
                ? (before?.memoryRequestMiBOverride ?? null)
                : tier.memoryRequestMiB,
            memoryLimitMiB:
              tier.memoryLimitMiB === undefined
                ? (before?.memoryLimitMiBOverride ?? null)
                : tier.memoryLimitMiB,
          };
        }),
      }
    : null;
  const next = resolveMcpRuntimeTiers(settings);
  if (!ResolvedMcpRuntimeTiersSchema.safeParse(next).success)
    throw new ApiError(
      400,
      "Calculated MCP memory exceeds the supported numeric range; set an explicit memory limit",
    );
  for (const tier of next.tiers) {
    if (tier.memoryLimitMiB < tier.memoryRequestMiB)
      throw new ApiError(
        400,
        `Tier ${tier.name}: the memory limit is below the memory request`,
      );
  }
  const removed = current.tiers.filter(
    (tier) =>
      !renamedAway.has(tier.name.toLowerCase()) &&
      (!findMcpRuntimeTier(next.tiers, tier.name) ||
        // Reusing its name does not retain the old tier identity. A valid
        // swap/chain renames the old tier away and is excluded above.
        renames.some(
          (rename) => rename.to.toLowerCase() === tier.name.toLowerCase(),
        )),
  );
  for (const tier of removed) {
    const count = await InternalMcpCatalogModel.countRuntimeTierReferences({
      organizationId,
      name: tier.name,
      tx,
    });
    if (count)
      throw new ApiError(
        400,
        `MCP tier ${tier.name} is used by ${count} MCP server${count === 1 ? "" : "s"}; move them to another tier first`,
      );
  }
  const resized = current.tiers
    .filter((before) => {
      const rename = renames.find(
        (rename) => rename.from.toLowerCase() === before.name.toLowerCase(),
      );
      const after = findMcpRuntimeTier(next.tiers, rename?.to ?? before.name);
      return (
        after &&
        (before.cpuRequest !== after.cpuRequest ||
          before.cpuLimit !== after.cpuLimit ||
          before.memoryRequestMiB !== after.memoryRequestMiB ||
          before.memoryLimitMiB !== after.memoryLimitMiB)
      );
    })
    .map((tier) => tier.name);
  return {
    settings,
    write: async (tx) => {
      await InternalMcpCatalogModel.markRuntimeTierResizes({
        organizationId,
        names: resized,
        tx,
      });
      await InternalMcpCatalogModel.renameRuntimeTiers({
        organizationId,
        renames,
        tx,
      });
    },
  };
}
