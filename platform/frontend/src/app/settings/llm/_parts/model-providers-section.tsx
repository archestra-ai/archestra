"use client";

import {
  builtInProviderLabel,
  isPersonalSubscriptionProvider,
  MAX_INTEGRATION_DISPLAY_NAME_LENGTH,
  type ModelProviderOverride,
  type ModelProviderOverrides,
  PERSONAL_SUBSCRIPTION_LABELS,
  type ProviderPlan,
  ProviderPlanSchema,
  providerPlans,
  pruneIntegrationOverrides,
  type SupportedProvider,
  SupportedProviders,
  subscriptionKindForProvider,
} from "@archestra/shared";
import { useEffect, useRef, useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { ProviderIcon } from "@/components/provider-icon";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SearchInput } from "@/components/search-input";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import { SubscriptionBrandIcon } from "@/components/subscription-brand-icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useOrganization,
  useUpdateIntegrationSettings,
} from "@/lib/organization.query";
import { providerSearchHaystack } from "@/lib/provider-search";

/**
 * Which model providers this deployment offers, and what it calls them.
 *
 * Availability and the name live on one row per provider because they are the
 * same decision made twice: a provider you offer usually needs the name your
 * organization knows it by. Splitting them into a chip list and a separate
 * list of name fields made the reader match provider to row across two
 * controls.
 *
 * A provider switched off leaves every picker, and the API refuses to
 * configure it. Keys that already exist keep working. A provider with more
 * than one way in gets one card per plan, so each switches off separately:
 * OpenAI, Anthropic and xAI API keys beside ChatGPT, Claude Code and
 * SuperGrok. Every plan off is the provider off.
 */
export function ModelProvidersSection() {
  const { data: organization } = useOrganization();
  const updateMutation = useUpdateIntegrationSettings(
    "Model providers updated",
    "Failed to update model providers",
  );

  const overrides = organization?.modelProviderOverrides ?? null;
  const savedDraft = toDraft(overrides);
  const savedKey = JSON.stringify(savedDraft);

  const [draft, setDraft] = useState(savedDraft);
  const [search, setSearch] = useState("");

  // Adopt what the server holds once the organization arrives, and again after
  // a save replaces it.
  const lastSavedKey = useRef(savedKey);
  useEffect(() => {
    if (lastSavedKey.current === savedKey) return;
    lastSavedKey.current = savedKey;
    setDraft(savedDraft);
  }, [savedKey, savedDraft]);

  const hasChanges = JSON.stringify(draft) !== savedKey;

  // Matches the organization's own name too, so a renamed provider is findable
  // by the name people here actually know it by, and the entry's aliases, so a
  // generic entry is findable by the products it serves.
  const query = search.trim().toLowerCase();
  const visible = CARDS.filter((card) =>
    providerSearchHaystack({
      provider: card.provider,
      labels: [
        cardLabel(card),
        cardName(draft[card.provider] ?? EMPTY_DRAFT_ENTRY, card),
        cardNote(card),
        // A personal subscription is also found by the provider it runs on.
        isPersonalCard(card) ? builtInProviderLabel(card.provider) : null,
      ],
    })
      .toLowerCase()
      .includes(query),
  );

  const patch = (provider: SupportedProvider, changes: Partial<DraftEntry>) =>
    setDraft((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], ...changes },
    }));

  const handleSave = async () => {
    const next: ModelProviderOverrides = {};
    for (const provider of SupportedProviders) {
      next[provider] = toOverride(provider, draft[provider]);
    }
    await updateMutation.mutateAsync({
      modelProviderOverrides: pruneIntegrationOverrides(next),
    });
  };

  return (
    <>
      <SettingsBlock
        id="model-providers"
        title="Model providers"
        description="Which providers this deployment offers, and the name it shows them under. A provider you switch off leaves every picker, and the API refuses to configure it — keys that already exist keep working."
        control={null}
      >
        <WithPermissions
          permissions={{ organizationSettings: ["update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => {
            const locked = updateMutation.isPending || !hasPermission;
            return (
              <div>
                <CollectionFilters>
                  <FilterBar
                    onClearFilters={search ? () => setSearch("") : undefined}
                    search={
                      <SearchInput
                        value={search}
                        onSearchChange={setSearch}
                        syncQueryParams={false}
                        placeholder="Search providers…"
                        className={filterSearchClass}
                      />
                    }
                  />
                </CollectionFilters>

                {visible.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No providers match “{search}”.
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {visible.map((card) => {
                      const { provider, plan } = card;
                      const entry = draft[provider] ?? EMPTY_DRAFT_ENTRY;
                      const label = cardLabel(card);
                      const id = cardId(card);
                      const note = cardNote(card);
                      // "ChatGPT personal subscription", "OpenAI API keys".
                      const fullLabel = note
                        ? `${label} ${note.replace(/^[A-Z][a-z]/, (start) => start.toLowerCase())}`
                        : label;
                      const available = plan
                        ? !entry.hiddenPlans[plan]
                        : !entry.hidden;
                      return (
                        <div
                          key={id}
                          data-testid={`model-provider-row-${id}`}
                          data-hidden={!available}
                          className="rounded-lg border bg-card/40 p-3 transition-colors data-[hidden=true]:opacity-60"
                        >
                          <div className="mb-2 flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-2">
                                {isPersonalCard(card) ? (
                                  <SubscriptionBrandIcon
                                    provider={provider}
                                    kind={subscriptionKindForProvider(provider)}
                                    size={18}
                                  />
                                ) : (
                                  <ProviderIcon provider={provider} size={18} />
                                )}
                                <span className="truncate text-sm font-medium">
                                  {label}
                                </span>
                              </div>
                              {note ? (
                                <p className="mt-0.5 truncate pl-[26px] text-xs text-muted-foreground">
                                  {note}
                                </p>
                              ) : null}
                            </div>
                            <Label
                              htmlFor={`model-provider-available-${id}`}
                              className="flex shrink-0 items-center gap-2 text-[11.5px] font-medium text-muted-foreground"
                            >
                              <Switch
                                id={`model-provider-available-${id}`}
                                checked={available}
                                onCheckedChange={(checked) =>
                                  plan
                                    ? patch(provider, {
                                        hiddenPlans: {
                                          ...entry.hiddenPlans,
                                          [plan]: !checked,
                                        },
                                      })
                                    : patch(provider, { hidden: !checked })
                                }
                                disabled={locked}
                                aria-label={`Make ${fullLabel} available`}
                              />
                              <span>Available</span>
                            </Label>
                          </div>
                          <Input
                            aria-label={`${fullLabel} display name`}
                            value={cardName(entry, card)}
                            onChange={(event) =>
                              patch(provider, {
                                [cardNameField(card)]: event.target.value,
                              })
                            }
                            placeholder={`Show as “${label}”`}
                            maxLength={MAX_INTEGRATION_DISPLAY_NAME_LENGTH}
                            disabled={locked}
                            className="mt-2 text-sm"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }}
        </WithPermissions>
      </SettingsBlock>
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateMutation.isPending}
        permissions={{ organizationSettings: ["update"] }}
        onSave={handleSave}
        onCancel={() => setDraft(savedDraft)}
      />
    </>
  );
}

/**
 * One card in the grid: a provider, or one plan of a provider with more than
 * one way in.
 */
type ProviderCard = { provider: SupportedProvider; plan?: ProviderPlan };

const CARDS: ProviderCard[] = SupportedProviders.flatMap(
  (provider): ProviderCard[] => {
    const plans = providerPlans(provider);
    return plans.length > 0
      ? plans.map((plan) => ({ provider, plan }))
      : [{ provider }];
  },
);

/**
 * The card's id in test ids and control ids. A provider's API key card keeps
 * the provider's own id, as it had before the provider got a second card.
 */
function cardId({ provider, plan }: ProviderCard): string {
  return plan && plan !== "apiKey" ? `${provider}-${plan}` : provider;
}

/**
 * A card that stands for a person's own subscription: a personal plan, or a
 * provider that is a personal subscription and nothing else.
 */
function isPersonalCard({ provider, plan }: ProviderCard): boolean {
  return (
    plan === "personal" ||
    (plan === undefined && isPersonalSubscriptionProvider(provider))
  );
}

/**
 * The name a card ships with: personal subscriptions beside API keys
 * (ChatGPT, Claude Code, SuperGrok) have their own, every other card the
 * provider's.
 */
function cardLabel(card: ProviderCard): string {
  if (cardNameField(card) === "personalDisplayName") {
    return PERSONAL_SUBSCRIPTION_LABELS[
      card.provider as keyof typeof PERSONAL_SUBSCRIPTION_LABELS
    ];
  }
  return builtInProviderLabel(card.provider);
}

/** The draft field a card's name input edits. */
function cardNameField(
  card: ProviderCard,
): "displayName" | "personalDisplayName" {
  if (card.plan === "personal") {
    return "personalDisplayName";
  }
  return "displayName";
}

/** The name an admin typed on this card. */
function cardName(entry: DraftEntry, card: ProviderCard): string {
  return entry[cardNameField(card)];
}

const PERSONAL_SUBSCRIPTION_NOTE = "Personal subscription";
const API_KEYS_NOTE = "API keys";

/**
 * The note beside a card's name, so an admin tells the cards of one provider
 * apart: "API keys" or "Personal subscription". Every personal subscription is
 * noted, from the shared list, so a subscription added later is noted with no
 * edit here.
 */
function cardNote(card: ProviderCard): string | null {
  if (card.plan === "apiKey") return API_KEYS_NOTE;
  return isPersonalCard(card) ? PERSONAL_SUBSCRIPTION_NOTE : null;
}

/**
 * The name inputs are controlled, so the draft holds "" rather than null. The
 * provider's name is `displayName`; the personal subscription beside API keys
 * has its own.
 */
type DraftEntry = {
  hidden: boolean;
  displayName: string;
  /** Providers with plans: their cards read and write these, never `hidden`. */
  hiddenPlans: Record<ProviderPlan, boolean>;
  personalDisplayName: string;
};

const EMPTY_DRAFT_ENTRY: DraftEntry = {
  hidden: false,
  displayName: "",
  hiddenPlans: { apiKey: false, personal: false },
  personalDisplayName: "",
};

function toDraft(
  overrides: ModelProviderOverrides | null,
): Record<SupportedProvider, DraftEntry> {
  const draft = {} as Record<SupportedProvider, DraftEntry>;
  for (const provider of SupportedProviders) {
    const override = overrides?.[provider];
    const hidden = override?.hidden === true;
    draft[provider] = {
      hidden,
      displayName: override?.displayName ?? "",
      // A provider switched off as a whole shows every plan card off.
      hiddenPlans: Object.fromEntries(
        ProviderPlanSchema.options.map((plan) => [
          plan,
          hidden || override?.plans?.[plan]?.hidden === true,
        ]),
      ) as Record<ProviderPlan, boolean>,
      personalDisplayName: override?.plans?.personal?.displayName ?? "",
    };
  }
  return draft;
}

/**
 * What one provider's cards save. Every plan card off is the provider off,
 * stored as the provider switch so every other place reads one answer; the
 * plans' names stay, so switching back on restores them.
 */
function toOverride(
  provider: SupportedProvider,
  entry: DraftEntry,
): ModelProviderOverride {
  const displayName = entry.displayName.trim() || null;
  const plans = providerPlans(provider);
  if (plans.length === 0) return { hidden: entry.hidden, displayName };
  const allOff = plans.every((plan) => entry.hiddenPlans[plan]);
  const names: Partial<Record<ProviderPlan, string | null>> = {
    personal: entry.personalDisplayName.trim() || null,
  };
  const planOverrides: NonNullable<ModelProviderOverride["plans"]> = {};
  for (const plan of plans) {
    const name = names[plan];
    planOverrides[plan] = {
      ...(allOff ? {} : { hidden: entry.hiddenPlans[plan] }),
      ...(name !== undefined ? { displayName: name } : {}),
    };
  }
  return allOff
    ? { hidden: true, displayName, plans: planOverrides }
    : { displayName, plans: planOverrides };
}
