"use client";

import {
  MAX_INTEGRATION_DISPLAY_NAME_LENGTH,
  type ModelProviderOverride,
  pruneIntegrationOverrides,
} from "@archestra/shared";
import { Search, Settings2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useUpdateIntegrationSettings } from "@/lib/organization.query";

/** One row of the dialog: a catalog entry the admin can turn off. */
export type IntegrationSettingsItem<Id extends string> = {
  id: Id;
  /** The name the entry ships with. */
  label: string;
  icon?: ReactNode;
};

/** Which organization column the dialog writes. */
type IntegrationCatalogField =
  | "modelProviderOverrides"
  | "messagingChannelOverrides"
  | "knowledgeConnectorOverrides";

/**
 * Admin-only control for one of the built-in integration catalogs — model
 * providers, messaging channels, or knowledge connectors. Mirrors the connect
 * page's "Page settings": a member never sees the button, and an admin gets a
 * per-entry switch.
 *
 * Turning an entry off is not cosmetic — the API refuses to configure a
 * turned-off entry — so the copy says "turned off", not "hidden".
 *
 * `allowRename` adds a name field. Only model providers take one: a channel or
 * a connector names a single external service, and renaming those would only
 * make their setup instructions harder to follow.
 */
export function IntegrationSettingsDialog<Id extends string>({
  field,
  title,
  description,
  entityNamePlural,
  items,
  overrides,
  allowRename = false,
  compact = false,
  testId,
}: {
  field: IntegrationCatalogField;
  title: string;
  description: string;
  /** Lowercase plural used in the search and empty copy, e.g. "providers". */
  entityNamePlural: string;
  items: IntegrationSettingsItem<Id>[];
  overrides: Partial<Record<Id, ModelProviderOverride>> | null;
  allowRename?: boolean;
  /**
   * Drops the search box. For a catalog short enough to read at a glance —
   * the five messaging channels — it is chrome around a list you can already
   * see all of.
   */
  compact?: boolean;
  testId: string;
}) {
  const { data: canUpdateSettings } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const [open, setOpen] = useState(false);

  if (!canUpdateSettings) return null;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        data-testid={testId}
      >
        <Settings2 className="mr-2 h-4 w-4" />
        <span>Page settings</span>
        <Badge variant="secondary" className="ml-2">
          Admin
        </Badge>
      </Button>
      {open && (
        <IntegrationSettingsForm
          field={field}
          title={title}
          description={description}
          entityNamePlural={entityNamePlural}
          items={items}
          overrides={overrides}
          allowRename={allowRename}
          compact={compact}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ===================================================================
// Internal pieces
// ===================================================================

/**
 * Mounted only while the dialog is open so the draft starts from the current
 * server state every time, rather than from whatever was left behind by an
 * earlier cancelled edit.
 */
function IntegrationSettingsForm<Id extends string>({
  field,
  title,
  description,
  entityNamePlural,
  items,
  overrides,
  allowRename,
  compact,
  onClose,
}: {
  field: IntegrationCatalogField;
  title: string;
  description: string;
  entityNamePlural: string;
  items: IntegrationSettingsItem<Id>[];
  overrides: Partial<Record<Id, ModelProviderOverride>> | null;
  allowRename: boolean;
  compact: boolean;
  onClose: () => void;
}) {
  const serverDraft = useMemo(
    () => toDraft(items, overrides),
    [items, overrides],
  );
  const [draft, setDraft] = useState(serverDraft);
  const [search, setSearch] = useState("");

  const updateMutation = useUpdateIntegrationSettings(
    "Settings updated",
    "Failed to update settings",
  );

  const isDirty = JSON.stringify(draft) !== JSON.stringify(serverDraft);

  // Matches the admin's own name too, so a renamed entry is findable by the
  // name their organization actually knows it by.
  const query = search.trim().toLowerCase();
  const visibleItems = items.filter((item) =>
    `${item.label} ${draft[item.id]?.displayName ?? ""}`
      .toLowerCase()
      .includes(query),
  );

  const patch = (id: Id, changes: Partial<DraftEntry>) =>
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id], ...changes } }));

  const handleSave = () => {
    const next: Partial<Record<Id, ModelProviderOverride>> = {};
    for (const item of items) {
      const entry = draft[item.id];
      if (!entry) continue;
      next[item.id] = allowRename
        ? { hidden: entry.hidden, displayName: entry.displayName }
        : { hidden: entry.hidden };
    }
    updateMutation.mutate(
      { [field]: pruneIntegrationOverrides(next) },
      { onSuccess: onClose },
    );
  };

  // The body carries no padding of its own: the search box sits in a fixed
  // block above a full-bleed scroll region, so the list's scrollbar runs edge
  // to edge — flush against the dialog's right side, and flush against the
  // block above it and the footer below.
  return (
    <StandardDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      isDirty={isDirty}
      title={title}
      description={description}
      size="medium"
      bodyClassName="flex flex-col overflow-hidden p-0"
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => setDraft(serverDraft)}
            disabled={!isDirty || updateMutation.isPending}
          >
            <span>Reset</span>
          </Button>
          <Button
            onClick={handleSave}
            disabled={!isDirty || updateMutation.isPending}
            data-testid="integration-settings-save"
          >
            <span>{updateMutation.isPending ? "Saving…" : "Save"}</span>
          </Button>
        </>
      }
    >
      {!compact && (
        <div className="px-4 pt-4 pb-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${entityNamePlural}…`}
              aria-label={`Search ${entityNamePlural}`}
              className="pl-8 text-sm"
            />
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-4">
        {visibleItems.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No {entityNamePlural} match “{search}”.
          </p>
        ) : (
          visibleItems.map((item) => {
            const entry = draft[item.id] ?? EMPTY_DRAFT_ENTRY;
            return (
              <div
                key={item.id}
                data-testid={`integration-settings-row-${item.id}`}
                data-hidden={entry.hidden}
                className="rounded-lg border bg-card/40 p-3 transition-colors data-[hidden=true]:opacity-60"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {item.icon}
                    <span className="truncate text-sm font-medium">
                      {item.label}
                    </span>
                  </div>
                  <Label
                    htmlFor={`integration-visible-${item.id}`}
                    className="flex shrink-0 items-center gap-2 text-[11.5px] font-medium text-muted-foreground"
                  >
                    <Switch
                      id={`integration-visible-${item.id}`}
                      checked={!entry.hidden}
                      onCheckedChange={(checked) =>
                        patch(item.id, { hidden: !checked })
                      }
                      aria-label={`Make ${item.label} available`}
                    />
                    <span>Available</span>
                  </Label>
                </div>
                {allowRename && (
                  <Input
                    aria-label={`${item.label} display name`}
                    value={entry.displayName}
                    onChange={(e) =>
                      patch(item.id, { displayName: e.target.value })
                    }
                    placeholder={`Show as “${item.label}”`}
                    maxLength={MAX_INTEGRATION_DISPLAY_NAME_LENGTH}
                    className="mt-2 text-sm"
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </StandardDialog>
  );
}

/** The name input is controlled, so the draft holds "" rather than null. */
type DraftEntry = { hidden: boolean; displayName: string };

const EMPTY_DRAFT_ENTRY: DraftEntry = { hidden: false, displayName: "" };

function toDraft<Id extends string>(
  items: IntegrationSettingsItem<Id>[],
  overrides: Partial<Record<Id, ModelProviderOverride>> | null,
): Record<Id, DraftEntry> {
  const draft = {} as Record<Id, DraftEntry>;
  for (const item of items) {
    const override = overrides?.[item.id];
    draft[item.id] = {
      hidden: override?.hidden === true,
      displayName: override?.displayName ?? "",
    };
  }
  return draft;
}
