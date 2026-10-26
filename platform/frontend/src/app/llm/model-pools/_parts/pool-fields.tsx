"use client";

import type { SupportedProvider } from "@archestra/shared";
import { ChevronDown, CircleHelp, Plus, TriangleAlert, X } from "lucide-react";
import { Controller, useFieldArray } from "react-hook-form";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import type { ModelPool } from "@/lib/model-pools.query";
import { cn } from "@/lib/utils/tailwind";
import { MemberStatus } from "./member-status";
import { suggestModelId } from "./model-name";
import {
  compactPriorities,
  hasRepeatedMember,
  isValidWeight,
  MAX_PRIORITY,
  MAX_WEIGHT,
  nextPriority,
  orderShare,
  type PoolForm,
  type PoolOptions,
} from "./pool-form";

type SavedMember = ModelPool["members"][number];

export function ModelNameField({
  form,
  options,
  disabled,
  taken,
}: {
  form: PoolForm;
  options: PoolOptions;
  disabled: boolean;
  taken: boolean;
}) {
  return (
    <div className="space-y-2">
      <span className="flex items-center gap-1.5">
        <Label htmlFor="pool-name">Model name</Label>
        <HelpTip topic="Model name">
          The name clients send as the model. Each request goes to one member,
          whichever provider it is on.
        </HelpTip>
      </span>
      <Controller
        control={form.control}
        name="name"
        render={({ field }) => (
          <SearchableSelect
            id="pool-name"
            value={field.value}
            onValueChange={(value) => {
              field.onChange(value);
              // Members still on the old name follow the new one.
              form.setValue(
                "members",
                form.getValues("members").map((member) =>
                  !member.modelId || member.modelId === field.value
                    ? {
                        ...member,
                        modelId: suggestModelId(
                          value,
                          options.keysById.get(member.providerApiKeyId)
                            ?.provider,
                          options.modelIdsByKey.get(member.providerApiKeyId),
                        ),
                      }
                    : member,
                ),
                { shouldDirty: true },
              );
            }}
            disabled={disabled}
            placeholder="e.g. glm-5"
            ariaLabel="Model name"
            searchPlaceholder="Search or type a model name"
            allowCustom
            className="w-full font-mono"
            items={options.modelNames.map((value) => ({ value, label: value }))}
          />
        )}
      />
      {taken ? (
        <InlineNotice>
          <TriangleAlert />
          <span className="font-medium">This name already has a pool</span>
          <InlineNoticeText>Add the members there instead.</InlineNoticeText>
        </InlineNotice>
      ) : null}
    </div>
  );
}

// Key, model id, order, weight, traffic, status, on, remove.
const MEMBER_COLUMNS =
  "@3xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_5rem_4.5rem_4.5rem_7.5rem_2.25rem_2rem]";

/**
 * One row per member, primaries first, so the list reads in the order
 * requests try them. In a wide dialog each row is one line under column
 * headers; in a narrow one it wraps to two.
 */
export function MembersEditor({
  form,
  options,
  disabled,
  savedMembers,
}: {
  form: PoolForm;
  options: PoolOptions;
  disabled: boolean;
  /** The saved members, with live status. Empty for a new pool. */
  savedMembers: SavedMember[];
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "members",
  });
  const name = form.watch("name").trim();
  const members = form.watch("members");
  const { sharedKeys, keysById, modelIdsByKey } = options;
  const nextKey =
    sharedKeys.find(
      (key) => !members.some((member) => member.providerApiKeyId === key.id),
    ) ?? sharedKeys[0];
  const lastOrder = Math.max(0, ...members.map((member) => member.priority));
  const orders = Array.from(
    { length: Math.min(lastOrder + 1, MAX_PRIORITY) },
    (_, index) => index + 1,
  );
  const order = fields
    .map((_, index) => index)
    .sort(
      (a, b) =>
        (members[a]?.priority ?? 0) - (members[b]?.priority ?? 0) || a - b,
    );

  // Keeps orders numbered 1, 2, 3 after a member moves or leaves.
  const renumber = () => {
    const current = form.getValues("members");
    compactPriorities(current).forEach((member, index) => {
      if (member.priority !== current[index]?.priority) {
        form.setValue(`members.${index}.priority`, member.priority, {
          shouldDirty: true,
        });
      }
    });
  };

  return (
    <div className="space-y-3">
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add the provider keys that serve this model.
        </p>
      ) : (
        <>
          <OrderChain members={members} />
          <div className="@container rounded-md border">
            <div
              className={cn(
                "hidden gap-2 border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground @3xl:grid",
                MEMBER_COLUMNS,
              )}
            >
              <span>Provider key</span>
              <span>Model ID</span>
              <span className="flex items-center gap-1">
                Order
                <HelpTip topic="Order">
                  Lower orders are tried first. A request moves to the next
                  order only when every member before it fails or is benched.
                </HelpTip>
              </span>
              <span className="flex items-center gap-1">
                Weight
                <HelpTip topic="Weight">
                  Splits traffic between members with the same order. 3 and 1
                  means 75% and 25%.
                </HelpTip>
              </span>
              <span>Traffic</span>
              <span>Status</span>
              <span>On</span>
            </div>
            <ul className="divide-y">
              {order.map((index) => {
                const field = fields[index];
                const member = members[index];
                const saved =
                  savedMembers.find(
                    (row) =>
                      row.providerApiKeyId === member?.providerApiKeyId &&
                      row.modelId === member?.modelId,
                  ) ?? null;
                const keyModels =
                  modelIdsByKey.get(member?.providerApiKeyId ?? "") ?? [];
                const provider = keysById.get(
                  member?.providerApiKeyId ?? "",
                )?.provider;
                const share = orderShare(members, index);
                const alone =
                  members.filter((other) => other.priority === member?.priority)
                    .length === 1;
                return (
                  <li
                    key={field.id}
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto] gap-2 p-3 @3xl:items-center @3xl:py-2",
                      MEMBER_COLUMNS,
                    )}
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 @3xl:contents">
                      <Controller
                        control={form.control}
                        name={`members.${index}.providerApiKeyId`}
                        render={({ field: keyField }) => (
                          <Select
                            value={keyField.value}
                            onValueChange={(value) => {
                              keyField.onChange(value);
                              form.setValue(
                                `members.${index}.modelId`,
                                suggestModelId(
                                  name,
                                  keysById.get(value)?.provider,
                                  modelIdsByKey.get(value),
                                ),
                                { shouldDirty: true },
                              );
                            }}
                            disabled={disabled}
                          >
                            <SelectTrigger
                              className="w-full min-w-0"
                              aria-label="Provider key"
                            >
                              <SelectValue placeholder="Choose a key" />
                            </SelectTrigger>
                            <SelectContent>
                              {sharedKeys.map((key) => (
                                <SelectItem key={key.id} value={key.id}>
                                  <span className="flex min-w-0 items-center gap-2">
                                    <ProviderIcon provider={key.provider} />
                                    <span className="truncate">{key.name}</span>
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                      <Controller
                        control={form.control}
                        name={`members.${index}.modelId`}
                        render={({ field: modelField }) => (
                          <SearchableSelect
                            value={modelField.value}
                            onValueChange={modelField.onChange}
                            disabled={disabled || !member?.providerApiKeyId}
                            placeholder="Model ID"
                            ariaLabel="Member model ID"
                            searchPlaceholder="Search or type a model ID"
                            allowCustom
                            className="w-full min-w-0 font-mono"
                            items={keyModels.map((value) => ({
                              value,
                              label: value,
                            }))}
                          />
                        )}
                      />
                    </div>
                    <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs @3xl:contents">
                      <Controller
                        control={form.control}
                        name={`members.${index}.priority`}
                        render={({ field: orderField }) => (
                          <Select
                            value={String(orderField.value)}
                            onValueChange={(value) => {
                              orderField.onChange(Number(value));
                              renumber();
                            }}
                            disabled={disabled}
                          >
                            <SelectTrigger
                              className="w-20 @3xl:w-full"
                              aria-label="Order"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {orders.map((order) => (
                                <SelectItem key={order} value={String(order)}>
                                  {order}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                      <Label className="gap-1.5 text-xs font-normal text-muted-foreground">
                        <span className="@3xl:sr-only">Weight</span>
                        <Input
                          type="number"
                          min={1}
                          max={MAX_WEIGHT}
                          className={cn(
                            "w-16 font-mono @3xl:w-full",
                            alone && "border-dashed text-muted-foreground",
                          )}
                          disabled={disabled}
                          aria-invalid={
                            member ? !isValidWeight(member.weight) : undefined
                          }
                          {...form.register(`members.${index}.weight`, {
                            valueAsNumber: true,
                          })}
                        />
                      </Label>
                      <TrafficShare
                        share={share}
                        order={member?.priority ?? 1}
                      />
                      <MemberStatus
                        enabled={member?.enabled ?? true}
                        saved={saved}
                      />
                      <Controller
                        control={form.control}
                        name={`members.${index}.enabled`}
                        render={({ field: enabledField }) => (
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <Switch
                              checked={enabledField.value}
                              onCheckedChange={enabledField.onChange}
                              disabled={disabled}
                              aria-label="Member on"
                            />
                            <span className="@3xl:sr-only">On</span>
                          </span>
                        )}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove member"
                      className="col-start-2 row-start-1 @3xl:col-auto @3xl:row-auto"
                      disabled={disabled}
                      onClick={() => {
                        remove(index);
                        renumber();
                      }}
                    >
                      <X />
                    </Button>
                    {member?.providerApiKeyId &&
                    member.modelId &&
                    !keyModels.includes(member.modelId) ? (
                      <p className="col-span-2 text-xs text-muted-foreground @3xl:col-span-full">
                        This key doesn't list {member.modelId}.
                      </p>
                    ) : null}
                    {provider === "bedrock" ? (
                      <p className="col-span-2 text-xs text-muted-foreground @3xl:col-span-full">
                        Anthropic-style clients such as Claude Code skip Bedrock
                        members.
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !nextKey}
          onClick={() =>
            nextKey &&
            append({
              providerApiKeyId: nextKey.id,
              modelId: suggestModelId(
                name,
                nextKey.provider,
                modelIdsByKey.get(nextKey.id),
              ),
              priority: nextPriority(members),
              weight: 1,
              enabled: true,
            })
          }
        >
          <Plus />
          <span>Add member</span>
        </Button>
        {sharedKeys.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            No shared provider keys yet.
          </span>
        ) : null}
        {hasRepeatedMember(members) ? (
          <span className="text-xs text-destructive">
            A key and model ID can be a member only once.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** "Order 1 · 2 → Order 2 · 1": the orders requests try, with member counts. */
function OrderChain({ members }: { members: { priority: number }[] }) {
  const counts = new Map<number, number>();
  for (const member of members) {
    counts.set(member.priority, (counts.get(member.priority) ?? 0) + 1);
  }
  const orders = [...counts.keys()].sort((a, b) => a - b);
  return (
    <ol
      aria-label="Order requests try members in"
      className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
    >
      {orders.map((order, position) => (
        <li key={order} className="flex items-center gap-1.5">
          {position > 0 ? <span aria-hidden="true">→</span> : null}
          <span className="rounded-full border bg-muted/50 px-2 py-0.5 text-foreground">
            Order {order} · {counts.get(order)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The member's percent of its order's traffic, with a bar; a dash when off. */
function TrafficShare({
  share,
  order,
}: {
  share: number | null;
  order: number;
}) {
  if (share === null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <span
      className="grid w-16 gap-1 text-xs tabular-nums @3xl:w-full"
      title={`${share}% of order ${order} traffic`}
    >
      <span>{share}%</span>
      <span className="h-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${share}%` }}
        />
      </span>
    </span>
  );
}

export function AccessField({
  form,
  options,
  disabled,
}: {
  form: PoolForm;
  options: PoolOptions;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <span className="flex items-center gap-1.5">
        <Label>Who can use it</Label>
        <HelpTip topic="Who can use it">
          Anyone whose key maps one of the members can already use this pool,
          including people who connected through Connect. Add a virtual key here
          when it maps none of them.
        </HelpTip>
      </span>
      <Controller
        control={form.control}
        name="virtualApiKeyIds"
        render={({ field }) => (
          <MultiSelectCombobox
            ariaLabel="Virtual keys that can use this pool"
            options={options.virtualKeys.map((key) => ({
              value: key.id,
              label: key.name,
            }))}
            value={field.value}
            onChange={field.onChange}
            placeholder="Add virtual keys"
            emptyMessage="No virtual keys found."
            disabled={disabled}
          />
        )}
      />
    </div>
  );
}

/** A "?" beside a label that explains it in one or two sentences. */
function HelpTip({
  topic,
  children,
}: {
  topic: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`About ${topic}`}
          className="inline-flex text-muted-foreground hover:text-foreground"
          onFocus={(event) => {
            // A dialog focuses its first control on open; only keyboard
            // focus should open the tip.
            if (!event.currentTarget.matches(":focus-visible")) {
              event.preventDefault();
            }
          }}
        >
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{children}</TooltipContent>
    </Tooltip>
  );
}

/** What the proxy does today, as rules the admin can open and read. */
export function FailureRules() {
  return (
    <Collapsible className="rounded-md border">
      <CollapsibleTrigger
        type="button"
        className="group flex w-full cursor-pointer items-center justify-between px-3 py-2 text-sm font-medium"
      >
        <span>When does a member count as failed?</span>
        <ChevronDown className="size-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="divide-y border-t">
          {RELIABILITY_RULES.map((rule) => (
            <div
              key={rule.label}
              className="grid gap-0.5 px-3 py-2 sm:grid-cols-[14rem_1fr] sm:gap-3"
            >
              <dt className="text-xs text-muted-foreground sm:text-sm">
                {rule.label}
              </dt>
              <dd className="text-sm">{rule.value}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

const RELIABILITY_RULES = [
  {
    label: "Move to the next member on",
    value: "429, 5xx, timeouts, connection errors, without retrying it",
  },
  {
    label: "Move on from a silent member",
    value:
      "No first chunk in 30 s, or no answer in 3 min plus 1 s per 20 tokens the request allows (at most 30 min), unless it is the last member",
  },
  {
    label: "Also move on when a key is refused",
    value: "401, 403, or 404 from that key, or a key that can't be loaded",
  },
  {
    label: "Stay and return the error on",
    value: "Invalid requests and other client errors",
  },
  {
    label: "Bench a failed member",
    value: "For its Retry-After, 30 s without one, at most 60 s",
  },
  {
    label: "Keep a conversation on one member",
    value: "On, to keep the prompt cache warm",
  },
  {
    label: "Once the answer has started",
    value: "Errors go to the client; no switch mid-answer",
  },
];

/** The providers a pool's members are on, as icons. */
export function PoolProviders({ pool }: { pool: ModelPool }) {
  const catalog = useModelProviderCatalog();
  const providers = [
    ...new Set(
      pool.members.map((member) => member.provider as SupportedProvider),
    ),
  ];
  return (
    <span className="flex items-center gap-1.5">
      {providers.map((provider) => (
        <ProviderIcon key={provider} provider={provider} />
      ))}
      <span className="truncate">
        {providers.map((provider) => catalog.label(provider)).join(", ")}
      </span>
    </span>
  );
}
