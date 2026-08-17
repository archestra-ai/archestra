import { z } from "zod";
import { CONNECTOR_TYPE_LABELS, type ConnectorType } from "./knowledge-base";
import { SupportedProvidersSchema } from "./model-constants";

/**
 * Messaging channels an admin can hide or relabel. Mirrors the tabs on
 * /messaging-channels: the three ChatOps providers plus email and A2A.
 */
export const MessagingChannelIdSchema = z.enum([
  "slack",
  "ms-teams",
  "telegram",
  "email",
  "a2a",
]);
export type MessagingChannelId = z.infer<typeof MessagingChannelIdSchema>;

export const MESSAGING_CHANNEL_LABELS: Record<MessagingChannelId, string> = {
  slack: "Slack",
  "ms-teams": "MS Teams",
  telegram: "Telegram",
  email: "Email",
  a2a: "A2A",
};

/**
 * Keyed off the label map so a connector type added to
 * `CONNECTOR_TYPE_LABELS` is configurable without a second edit here.
 */
export const KnowledgeConnectorIdSchema = z.enum(
  Object.keys(CONNECTOR_TYPE_LABELS) as [ConnectorType, ...ConnectorType[]],
);

export const MAX_INTEGRATION_DISPLAY_NAME_LENGTH = 60;
export const MAX_INTEGRATION_DESCRIPTION_LENGTH = 300;

/**
 * One admin override of a built-in catalog entry — a model provider, a
 * messaging channel, or a knowledge connector.
 *
 * `hidden` is the off switch: a hidden entry disappears from the pickers and
 * the API refuses to configure it, so hiding is a real restriction rather than
 * cosmetic. `displayName` and `description` only change how the entry reads,
 * mirroring the per-URL customization on the connect page. Every field is
 * optional; an absent entry means "visible, named as it ships".
 */
export const IntegrationOverrideSchema = z.object({
  hidden: z.boolean().optional(),
  displayName: z
    .string()
    .trim()
    .max(MAX_INTEGRATION_DISPLAY_NAME_LENGTH)
    .nullish(),
  description: z
    .string()
    .trim()
    .max(MAX_INTEGRATION_DESCRIPTION_LENGTH)
    .nullish(),
});
export type IntegrationOverride = z.infer<typeof IntegrationOverrideSchema>;

export const ModelProviderOverridesSchema = z.partialRecord(
  SupportedProvidersSchema,
  IntegrationOverrideSchema,
);
export type ModelProviderOverrides = z.infer<
  typeof ModelProviderOverridesSchema
>;

export const MessagingChannelOverridesSchema = z.partialRecord(
  MessagingChannelIdSchema,
  IntegrationOverrideSchema,
);
export type MessagingChannelOverrides = z.infer<
  typeof MessagingChannelOverridesSchema
>;

export const KnowledgeConnectorOverridesSchema = z.partialRecord(
  KnowledgeConnectorIdSchema,
  IntegrationOverrideSchema,
);
export type KnowledgeConnectorOverrides = z.infer<
  typeof KnowledgeConnectorOverridesSchema
>;

type IntegrationOverrides<Id extends string> = Partial<
  Record<Id, IntegrationOverride>
> | null;

/** True when an admin has switched this catalog entry off. */
export function isIntegrationHidden<Id extends string>(
  overrides: IntegrationOverrides<Id>,
  id: Id,
): boolean {
  return overrides?.[id]?.hidden === true;
}

/**
 * The label to render for a catalog entry: the admin's override when they set
 * one, otherwise the built-in name.
 */
export function integrationLabel<Id extends string>(
  overrides: IntegrationOverrides<Id>,
  id: Id,
  fallback: string,
): string {
  const custom = overrides?.[id]?.displayName?.trim();
  return custom ? custom : fallback;
}

/** The admin's extra blurb for a catalog entry, or null when they set none. */
export function integrationDescription<Id extends string>(
  overrides: IntegrationOverrides<Id>,
  id: Id,
): string | null {
  const custom = overrides?.[id]?.description?.trim();
  return custom ? custom : null;
}

/**
 * Drops entries that carry no customization, so an admin who toggles a
 * provider off and back on leaves no residue behind and newly added catalog
 * entries keep defaulting to visible.
 */
export function pruneIntegrationOverrides<Id extends string>(
  overrides: Partial<Record<Id, IntegrationOverride>>,
): Partial<Record<Id, IntegrationOverride>> | null {
  const pruned: Partial<Record<Id, IntegrationOverride>> = {};
  for (const [id, override] of Object.entries(overrides) as [
    Id,
    IntegrationOverride | undefined,
  ][]) {
    if (!override) continue;
    const displayName = override.displayName?.trim() || null;
    const description = override.description?.trim() || null;
    const hidden = override.hidden === true;
    if (!hidden && !displayName && !description) continue;
    pruned[id] = {
      ...(hidden ? { hidden: true } : {}),
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
    };
  }
  return Object.keys(pruned).length > 0 ? pruned : null;
}
