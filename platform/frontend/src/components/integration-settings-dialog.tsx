"use client";

import {
  type IntegrationOverride,
  MAX_INTEGRATION_DESCRIPTION_LENGTH,
  MAX_INTEGRATION_DISPLAY_NAME_LENGTH,
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

/** One row of the dialog: a catalog entry the admin can hide or relabel. */
export type IntegrationSettingsItem<Id extends string> = {
  id: Id;
  /** The built-in name, shown as the placeholder for the custom label. */
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
 * per-entry switch plus the label and blurb overrides that decide how the
 * entry reads everywhere else.
 *
 * Hiding is not cosmetic — the API refuses to configure a hidden entry — so
 * the copy says "turned off", not "hidden".
 */
export function IntegrationSettingsDialog<Id extends string>({
  field,
  title,
  description,
  entityNamePlural,
  items,
  overrides,
  testId,
}: {
  field: IntegrationCatalogField;
  title: string;
  description: string;
  /** Lowercase plural used in the empty/summary copy, e.g. "providers". */
  entityNamePlural: string;
  items: IntegrationSettingsItem<Id>[];
  overrides: Partial<Record<Id, IntegrationOverride>> | null;
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
  onClose,
}: {
  field: IntegrationCatalogField;
  title: string;
  description: string;
  entityNamePlural: string;
  items: IntegrationSettingsItem<Id>[];
  overrides: Partial<Record<Id, IntegrationOverride>> | null;
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
  const hiddenCount = items.filter((item) => draft[item.id]?.hidden).length;

  // Matches the admin's own label too, so a renamed entry is findable by the
  // name their organization actually knows it by.
  const query = search.trim().toLowerCase();
  const visibleItems = items.filter((item) =>
    `${item.label} ${draft[item.id]?.displayName ?? ""}`
      .toLowerCase()
      .includes(query),
  );

  const patch = (id: Id, changes: Partial<DraftEntry>) =>
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id], ...changes } }));

  const setAllHidden = (hidden: boolean) =>
    setDraft((prev) => {
      const next = { ...prev };
      for (const item of items) {
        next[item.id] = { ...next[item.id], hidden };
      }
      return next;
    });

  const handleSave = () => {
    const next: Partial<Record<Id, IntegrationOverride>> = {};
    for (const item of items) {
      const entry = draft[item.id];
      if (!entry) continue;
      next[item.id] = {
        hidden: entry.hidden,
        displayName: entry.displayName,
        description: entry.description,
      };
    }
    updateMutation.mutate(
      { [field]: pruneIntegrationOverrides(next) },
      { onSuccess: onClose },
    );
  };

  // The body carries no padding of its own: the search box and the "N turned
  // off" summary sit in a fixed block above a full-bleed scroll region, so the
  // list's scrollbar runs edge to edge — flush against the dialog's right side,
  // and flush against the block above it and the footer below.
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
      <div className="flex flex-col gap-2 px-4 pt-4 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* A plain input rather than the shared SearchInput: this filter is
              dialog-local, and SearchInput mirrors its value into the page URL. */}
          <div className="relative max-w-64 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${entityNamePlural}…`}
              aria-label={`Search ${entityNamePlural}`}
              className="pl-8 text-sm"
            />
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAllHidden(false)}
            >
              <span>Turn all on</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAllHidden(true)}
            >
              <span>Turn all off</span>
            </Button>
          </div>
        </div>

        <p className="text-[13px] text-muted-foreground">
          {hiddenCount === 0 ? (
            <span>All {entityNamePlural} are available.</span>
          ) : (
            <span>
              {hiddenCount} of {items.length} {entityNamePlural} turned off —
              they are hidden everywhere and cannot be configured.
            </span>
          )}
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-4">
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
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <Input
                    aria-label={`${item.label} display name`}
                    value={entry.displayName}
                    onChange={(e) =>
                      patch(item.id, { displayName: e.target.value })
                    }
                    placeholder={item.label}
                    maxLength={MAX_INTEGRATION_DISPLAY_NAME_LENGTH}
                    className="text-sm"
                  />
                  <Input
                    aria-label={`${item.label} description`}
                    value={entry.description}
                    onChange={(e) =>
                      patch(item.id, { description: e.target.value })
                    }
                    placeholder="Description (optional)"
                    maxLength={MAX_INTEGRATION_DESCRIPTION_LENGTH}
                    className="text-sm"
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </StandardDialog>
  );
}

/** Inputs are controlled, so the draft holds "" rather than null/undefined. */
type DraftEntry = { hidden: boolean; displayName: string; description: string };

const EMPTY_DRAFT_ENTRY: DraftEntry = {
  hidden: false,
  displayName: "",
  description: "",
};

function toDraft<Id extends string>(
  items: IntegrationSettingsItem<Id>[],
  overrides: Partial<Record<Id, IntegrationOverride>> | null,
): Record<Id, DraftEntry> {
  const draft = {} as Record<Id, DraftEntry>;
  for (const item of items) {
    const override = overrides?.[item.id];
    draft[item.id] = {
      hidden: override?.hidden === true,
      displayName: override?.displayName ?? "",
      description: override?.description ?? "",
    };
  }
  return draft;
}
