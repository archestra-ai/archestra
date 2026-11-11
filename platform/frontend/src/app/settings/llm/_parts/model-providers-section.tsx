"use client";

import {
  builtInProviderLabel,
  type CopilotPlan,
  CopilotPlanSchema,
  GITHUB_COPILOT_ORGANIZATION_LABEL,
  MAX_INTEGRATION_DISPLAY_NAME_LENGTH,
  type ModelProviderOverrides,
  PERSONAL_SUBSCRIPTION_PROVIDERS,
  pruneIntegrationOverrides,
  type SupportedProvider,
  SupportedProviders,
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
 * configure it. Keys that already exist keep working. GitHub Copilot gets one
 * card per plan, so personal subscriptions and enterprise plans switch off
 * separately; both off is GitHub Copilot off.
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
  const visible = CARDS.filter(({ provider, plan }) =>
    providerSearchHaystack({
      provider,
      labels: [
        cardLabel({ provider, plan }),
        cardName(draft[provider] ?? EMPTY_DRAFT_ENTRY, plan),
        cardNote({ provider, plan }),
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
      const entry = draft[provider];
      const displayName = entry.displayName.trim() || null;
      if (provider !== "github-copilot") {
        next[provider] = { hidden: entry.hidden, displayName };
        continue;
      }
      // Both plan cards off is GitHub Copilot off, stored as the provider
      // switch so every other place reads one answer.
      const bothOff = CopilotPlanSchema.options.every(
        (plan) => entry.hiddenPlans[plan],
      );
      const enterpriseName = entry.enterpriseDisplayName.trim() || null;
      next[provider] = bothOff
        ? {
            hidden: true,
            displayName,
            plans: { enterprise: { displayName: enterpriseName } },
          }
        : {
            displayName,
            plans: {
              personal: { hidden: entry.hiddenPlans.personal },
              enterprise: {
                hidden: entry.hiddenPlans.enterprise,
                displayName: enterpriseName,
              },
            },
          };
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
                    {visible.map(({ provider, plan }) => {
                      const entry = draft[provider] ?? EMPTY_DRAFT_ENTRY;
                      const label = cardLabel({ provider, plan });
                      const id = plan ? `${provider}-${plan}` : provider;
                      const note = cardNote({ provider, plan });
                      const fullLabel = note
                        ? `${label} ${note.toLowerCase()}`
                        : label;
                      const available = plan
                        ? !entry.hiddenPlans[plan]
                        : !entry.hidden;
                      return (
                        <div
                          key={id}
                          data-testid={`model-provider-row-${id}`}
                          data-hidden={!available}
                          className="flex flex-col rounded-lg border bg-card/40 p-3 transition-colors data-[hidden=true]:opacity-60"
                        >
                          <div className="mb-2 flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-2">
                                <ProviderIcon provider={provider} size={18} />
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
                            value={cardName(entry, plan)}
                            onChange={(event) =>
                              patch(
                                provider,
                                plan === "enterprise"
                                  ? {
                                      enterpriseDisplayName: event.target.value,
                                    }
                                  : { displayName: event.target.value },
                              )
                            }
                            placeholder={`Show as “${label}”`}
                            maxLength={MAX_INTEGRATION_DISPLAY_NAME_LENGTH}
                            disabled={locked}
                            className="mt-auto text-sm"
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

/** One card in the grid: a provider, or one of GitHub Copilot's two plans. */
type ProviderCard = { provider: SupportedProvider; plan?: CopilotPlan };

const CARDS: ProviderCard[] = SupportedProviders.flatMap(
  (provider): ProviderCard[] =>
    provider === "github-copilot"
      ? CopilotPlanSchema.options.map((plan) => ({ provider, plan }))
      : [{ provider }],
);

/**
 * The name a card ships with: the GitHub Copilot enterprise plan has its own,
 * every other card the provider's.
 */
function cardLabel({ provider, plan }: ProviderCard): string {
  return plan === "enterprise"
    ? GITHUB_COPILOT_ORGANIZATION_LABEL
    : builtInProviderLabel(provider);
}

/** The name an admin typed on this card: the plan's own, or the provider's. */
function cardName(entry: DraftEntry, plan: CopilotPlan | undefined): string {
  return plan === "enterprise"
    ? entry.enterpriseDisplayName
    : entry.displayName;
}

const PERSONAL_SUBSCRIPTION_NOTE = "Personal subscription";
const ENTERPRISE_PLAN_NOTE = "Enterprise plan";

/**
 * The note beside a card's name: every personal subscription provider gets
 * one, from the shared list, so a subscription added later is noted with no
 * edit here. GitHub Copilot's enterprise plan card is the one exception.
 */
function cardNote({ provider, plan }: ProviderCard): string | null {
  if (plan === "enterprise") return ENTERPRISE_PLAN_NOTE;
  return PERSONAL_SUBSCRIPTION_PROVIDERS.includes(provider)
    ? PERSONAL_SUBSCRIPTION_NOTE
    : null;
}

/**
 * The name inputs are controlled, so the draft holds "" rather than null. The
 * GitHub Copilot personal card edits the provider's name, the enterprise card
 * its own.
 */
type DraftEntry = {
  hidden: boolean;
  displayName: string;
  /** GitHub Copilot only: its cards read and write these, never `hidden`. */
  hiddenPlans: Record<CopilotPlan, boolean>;
  enterpriseDisplayName: string;
};

const EMPTY_DRAFT_ENTRY: DraftEntry = {
  hidden: false,
  displayName: "",
  hiddenPlans: { personal: false, enterprise: false },
  enterpriseDisplayName: "",
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
      // GitHub Copilot switched off as a provider shows both plan cards off.
      hiddenPlans: {
        personal: hidden || override?.plans?.personal?.hidden === true,
        enterprise: hidden || override?.plans?.enterprise?.hidden === true,
      },
      enterpriseDisplayName: override?.plans?.enterprise?.displayName ?? "",
    };
  }
  return draft;
}
