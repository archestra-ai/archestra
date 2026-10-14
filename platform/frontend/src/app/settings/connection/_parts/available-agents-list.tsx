"use client";

import {
  providerRequiresPerUserCredential,
  type SupportedProvider,
} from "@archestra/shared";
import {
  INSTALLER_CLIENT_IDS,
  INSTALLER_CLIENT_KEY_PROVIDERS,
  type InstallerClientId,
  isOpenCodeFamilyClient,
} from "@archestra/shared/connection-setup";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Terminal, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ClientIcon } from "@/app/connection/client-icon";
import type { ConnectClient } from "@/app/connection/clients";
import { ProviderKeyList } from "@/components/credential-billing/provider-key-list";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { ProviderAccessField } from "@/components/provider-access-field";
import { ProviderIcon } from "@/components/provider-icon";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils/tailwind";

export type ClientProviderKeys = Partial<
  Record<InstallerClientId, ProviderApiKeyMappings>
>;

/**
 * The agents users see on Connect, in order, each with the provider keys its
 * setup command maps to. Removed agents fold into one "Add back" line.
 */
export function AvailableAgentsList({
  clients,
  shownClientIds,
  onShownClientIdsChange,
  onOrderChange,
  clientFutureProviders,
  onClientFutureProvidersChange,
  clientProviderKeys,
  onClientKeysChange,
  providerApiKeys,
  disabled,
}: {
  /** Every client admins can show, in the current order (shown and hidden). */
  clients: ConnectClient[];
  shownClientIds: string[];
  onShownClientIdsChange: (ids: string[]) => void;
  /** Receives the full order: shown clients first, then hidden ones. */
  onOrderChange: (ids: string[]) => void;
  clientFutureProviders: Partial<Record<InstallerClientId, boolean>>;
  onClientFutureProvidersChange: (
    clientId: InstallerClientId,
    value: boolean,
  ) => void;
  clientProviderKeys: ClientProviderKeys;
  onClientKeysChange: (
    clientId: InstallerClientId,
    value: ProviderApiKeyMappings,
  ) => void;
  /** Keys an admin can map; per-user providers are already excluded. */
  providerApiKeys: LlmProviderApiKeyResponse[];
  disabled: boolean;
}) {
  const [openId, setOpenId] = useState<InstallerClientId | null>(null);
  const shown = clients.filter((c) => shownClientIds.includes(c.id));
  const hidden = clients.filter((c) => !shownClientIds.includes(c.id));
  const shownIds = shown.map((c) => c.id);
  const hiddenIds = hidden.map((c) => c.id);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const move = (from: number, to: number) => {
    if (disabled || from < 0 || to < 0 || to >= shownIds.length) return;
    if (from === to) return;
    onOrderChange([...arrayMove(shownIds, from, to), ...hiddenIds]);
  };
  const show = (id: string) => {
    if (disabled || shownClientIds.includes(id)) return;
    onShownClientIdsChange([...shownClientIds, id]);
    onOrderChange([...shownIds, id, ...hiddenIds.filter((h) => h !== id)]);
  };
  const remove = (id: string) => {
    if (disabled) return;
    onShownClientIdsChange(shownClientIds.filter((s) => s !== id));
    onOrderChange([...shownIds.filter((s) => s !== id), id, ...hiddenIds]);
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    move(
      shownIds.indexOf(String(active.id)),
      shownIds.indexOf(String(over.id)),
    );
  };

  const keysFor = (clientId: InstallerClientId) =>
    providerApiKeys.filter((key) =>
      (
        INSTALLER_CLIENT_KEY_PROVIDERS[clientId] as readonly SupportedProvider[]
      ).includes(key.provider),
    );
  const mappedKeys = (clientId: InstallerClientId) =>
    (clientProviderKeys[clientId] ?? []).flatMap(
      (mapping) =>
        providerApiKeys.find((key) => key.id === mapping.providerApiKeyId) ??
        [],
    );
  const openClient = clients.find((c) => c.id === openId) ?? null;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-2">
        <div className="overflow-hidden rounded-lg border bg-card">
          {shown.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No agents on Connect. Add one back below.
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={shownIds}
                strategy={verticalListSortingStrategy}
              >
                <ul aria-label="Agents users can connect" className="divide-y">
                  {shown.map((client, index) => {
                    const installerId = asInstallerClientId(client.id);
                    return (
                      <SortableRow
                        key={client.id}
                        client={client}
                        index={index}
                        disabled={disabled}
                        status={
                          installerId ? (
                            <KeysBadge
                              clientId={installerId}
                              includeFutureProviders={
                                clientFutureProviders[installerId] ?? false
                              }
                              mapped={mappedKeys(installerId)}
                            />
                          ) : (
                            <Pill tone="manual">
                              <Terminal className="size-3" />
                              Manual setup
                            </Pill>
                          )
                        }
                        onOpen={
                          installerId ? () => setOpenId(installerId) : null
                        }
                        onMove={(direction) => move(index, index + direction)}
                        onRemove={() => remove(client.id)}
                      />
                    );
                  })}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>

        {hidden.length > 0 && (
          <HiddenFooter hidden={hidden} disabled={disabled} onAdd={show} />
        )}
      </div>

      <Dialog
        open={openClient !== null}
        onOpenChange={(open) => !open && setOpenId(null)}
      >
        <DialogContent className="max-w-xl">
          {openClient && openId && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <ClientIcon client={openClient} size={40} />
                  <div className="min-w-0 space-y-1.5">
                    <DialogTitle>{openClient.label}</DialogTitle>
                    <DialogDescription>
                      Choose which providers are available when users connect
                      this agent.
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>
              <DialogBody>
                <ClientKeys
                  clientId={openId}
                  includeFutureProviders={
                    clientFutureProviders[openId] ?? false
                  }
                  onIncludeFutureProvidersChange={(value) =>
                    onClientFutureProvidersChange(openId, value)
                  }
                  keys={keysFor(openId)}
                  value={clientProviderKeys[openId] ?? []}
                  onChange={(value) => onClientKeysChange(openId, value)}
                  disabled={disabled}
                />
              </DialogBody>
              <DialogFooter className="sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  {disabled ? "Read only." : "Changes save with the page."}
                </p>
                <Button type="button" onClick={() => setOpenId(null)}>
                  Done
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

// ===================================================================
// Internal pieces
// ===================================================================

function SortableRow({
  client,
  index,
  disabled,
  status,
  onOpen,
  onMove,
  onRemove,
}: {
  client: ConnectClient;
  index: number;
  disabled: boolean;
  status: ReactNode;
  /** Null for agents without a setup command: there is nothing to open. */
  onOpen: (() => void) | null;
  onMove: (direction: number) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: client.id, disabled });

  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2.5">
        <ClientIcon client={client} size={22} />
        <span className="truncate text-sm font-medium">{client.label}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center">{status}</span>
    </>
  );

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex h-11 items-center bg-card",
        isDragging && "relative z-10 rounded-md shadow-md ring-1 ring-border",
      )}
    >
      <UnstyledButton
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${client.label}, position ${index + 1}`}
        disabled={disabled}
        className="flex h-full w-9 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
        onKeyDown={(event) => {
          if (!isDragging && ["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            onMove(event.key === "ArrowUp" ? -1 : 1);
          } else {
            listeners?.onKeyDown?.(event);
          }
        }}
      >
        <GripVertical className="size-4" />
      </UnstyledButton>
      {onOpen ? (
        <UnstyledButton
          onClick={onOpen}
          aria-label={`${client.label} provider keys`}
          className="flex h-full min-w-0 flex-1 items-center gap-3 pr-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted"
        >
          {body}
        </UnstyledButton>
      ) : (
        <div className="flex h-full min-w-0 flex-1 items-center gap-3 pr-2">
          {body}
        </div>
      )}
      <span className="flex w-10 shrink-0 justify-center">
        {!disabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={onRemove}
                aria-label={`Remove ${client.label} from Connect`}
                className="text-muted-foreground/50 hover:text-foreground"
              >
                <X className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Remove from Connect</TooltipContent>
          </Tooltip>
        )}
      </span>
    </li>
  );
}

/** "3 hidden · [icons] · Add back": the removed agents, out of the way. */
function HiddenFooter({
  hidden,
  disabled,
  onAdd,
}: {
  hidden: ConnectClient[];
  disabled: boolean;
  onAdd: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const stack = hidden.slice(0, HIDDEN_ICON_LIMIT);
  const extra = hidden.length - stack.length;

  return (
    <div className="flex h-7 items-center gap-2 px-1 text-xs text-muted-foreground">
      <span className="tabular-nums">{hidden.length} hidden</span>
      <span className="flex items-center -space-x-1.5" aria-hidden>
        {stack.map((c) => (
          <span
            key={c.id}
            className="flex size-5 items-center justify-center rounded-full bg-card opacity-70 ring-2 ring-background grayscale"
          >
            <ClientIcon client={c} size={14} />
          </span>
        ))}
        {extra > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1 text-[10px] tabular-nums ring-2 ring-background">
            +{extra}
          </span>
        )}
      </span>
      {!disabled && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <UnstyledButton
              aria-label="Add an agent back to Connect"
              className="ml-0.5 inline-flex items-center gap-1 rounded-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-3" />
              Add back
            </UnstyledButton>
          </PopoverTrigger>
          <PopoverContent className="w-60 p-0" align="start">
            <Command>
              {hidden.length > SEARCH_THRESHOLD && (
                <CommandInput placeholder="Search agents" />
              )}
              <CommandList>
                <CommandEmpty>No match.</CommandEmpty>
                {hidden.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={c.label}
                    onSelect={() => {
                      onAdd(c.id);
                      if (hidden.length <= 1) setOpen(false);
                    }}
                    className="gap-2.5"
                  >
                    <ClientIcon client={c} size={18} />
                    <span className="truncate">{c.label}</span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function KeysBadge({
  clientId,
  mapped,
  includeFutureProviders,
}: {
  clientId: InstallerClientId;
  mapped: LlmProviderApiKeyResponse[];
  includeFutureProviders: boolean;
}) {
  const catalog = useModelProviderCatalog();
  if (includeFutureProviders)
    return <Pill tone="admin">Current and future providers</Pill>;
  if (mapped.length === 0) {
    return <Pill tone="own">{ownKeysLabel(clientId)}</Pill>;
  }
  const providers = [...new Set(mapped.map((key) => key.provider))];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Pill tone="admin">
            <span className="flex -space-x-1">
              {providers.slice(0, BADGE_ICON_LIMIT).map((provider) => (
                <span
                  key={provider}
                  className="flex size-4 items-center justify-center rounded-full bg-background ring-1 ring-primary/20"
                >
                  <ProviderIcon provider={provider} size={10} />
                </span>
              ))}
            </span>
            <span>Admin keys</span>
            <span className="text-primary/50">·</span>
            <span className="tabular-nums">{mapped.length}</span>
          </Pill>
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-64">
        <ul className="space-y-0.5">
          {mapped.map((key) => (
            <li key={key.id}>
              <span className="opacity-70">{catalog.label(key.provider)}:</span>{" "}
              {key.name}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

function Pill({
  tone,
  children,
}: {
  tone: "admin" | "own" | "manual";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs",
        tone === "admin" &&
          "border-primary/25 bg-primary/10 font-medium text-primary",
        tone === "own" && "border-border bg-muted text-foreground/80",
        tone === "manual" &&
          "border-dashed border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function ClientKeys({
  includeFutureProviders,
  onIncludeFutureProvidersChange,
  clientId,
  keys,
  value,
  onChange,
  disabled,
}: {
  includeFutureProviders: boolean;
  onIncludeFutureProvidersChange: (value: boolean) => void;
  clientId: InstallerClientId;
  keys: LlmProviderApiKeyResponse[];
  value: ProviderApiKeyMappings;
  onChange: (value: ProviderApiKeyMappings) => void;
  disabled: boolean;
}) {
  const own = ownKeysLabel(clientId).toLowerCase();
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <ProviderAccessField
        surface="connect"
        canIncludeFutureProviders={INSTALLER_CLIENT_KEY_PROVIDERS[
          clientId
        ].some((provider) => !providerRequiresPerUserCredential(provider))}
        includeFutureProviders={includeFutureProviders}
        onIncludeFutureProvidersChange={onIncludeFutureProvidersChange}
        current={
          <ProviderKeyList
            label="Provider keys"
            alwaysOpen
            emptyLabel={
              includeFutureProviders
                ? "Uses primary API keys — add a provider to choose a different key"
                : `No keys picked: setup uses ${own}.`
            }
            value={value}
            onChange={onChange}
            providerApiKeys={keys}
          />
        }
      />
    </fieldset>
  );
}

function asInstallerClientId(id: string): InstallerClientId | null {
  return INSTALLER_CLIENT_IDS.find((clientId) => clientId === id) ?? null;
}

function ownKeysLabel(clientId: InstallerClientId): string {
  return clientId === "cursor" || isOpenCodeFamilyClient(clientId)
    ? "Users' primary keys"
    : "Users' own keys";
}

const HIDDEN_ICON_LIMIT = 4;
const BADGE_ICON_LIMIT = 3;
const SEARCH_THRESHOLD = 6;
