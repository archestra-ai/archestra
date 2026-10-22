"use client";

import { isModelPoolProvider, type SupportedProvider } from "@archestra/shared";
import { Plus, Trash2, TriangleAlert, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { PermissionButton } from "@/components/ui/permission-button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  type ModelPool,
  type ModelPoolInput,
  useCreateModelPool,
  useDeleteModelPool,
  useModelPools,
  useUpdateModelPool,
} from "@/lib/model-pools.query";
import { cn } from "@/lib/utils/tailwind";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";
import { MemberStatus } from "./member-status";

type PoolFormValues = {
  name: string;
  members: {
    providerApiKeyId: string;
    modelId: string;
    priority: number;
    weight: number;
    enabled: boolean;
  }[];
  virtualApiKeyIds: string[];
};

/**
 * Creates or edits one pool. `pool` null means a new pool; saving one hands
 * its id back through `onSaved` so the page can select it.
 */
export function PoolEditor({
  pool,
  onSaved,
  onDeleted,
}: {
  pool: ModelPool | null;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const { data: canEdit } = useHasPermissions({ llmModel: ["update"] });
  const form = useForm<PoolFormValues>({ defaultValues: toFormValues(pool) });
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "members",
  });
  // A different pool, or the saved copy of this one, replaces the form.
  useEffect(() => {
    form.reset(toFormValues(pool));
  }, [pool, form]);

  const name = form.watch("name").trim();
  const members = form.watch("members");

  const { data: allKeys = [] } = useLlmProviderApiKeys();
  // Personal keys belong to one user, so only shared keys on providers a pool
  // can send to can be members.
  const sharedKeys = useMemo(
    () =>
      allKeys
        .filter(
          (key) => key.userId === null && isModelPoolProvider(key.provider),
        )
        .sort(
          (a, b) =>
            a.provider.localeCompare(b.provider) ||
            a.name.localeCompare(b.name),
        ),
    [allKeys],
  );
  const keysById = new Map(sharedKeys.map((key) => [key.id, key]));

  const { data: models = [] } = useModelsWithApiKeys({
    includeAssignments: false,
  });
  // The model ids each key lists, to suggest and check a member's model id.
  const modelIdsByKey = useMemo(() => {
    const byKey = new Map<string, string[]>();
    for (const model of models) {
      for (const key of model.apiKeys) {
        byKey.set(key.id, [...(byKey.get(key.id) ?? []), model.modelId]);
      }
    }
    return byKey;
  }, [models]);
  const modelNames = useMemo(
    () => [...new Set(models.map((model) => model.modelId))].sort(),
    [models],
  );

  // Pass-through keys carry the caller's own provider key, so they can't
  // spend a pool's keys.
  const { data: virtualKeyPage } = useAllVirtualApiKeys({
    limit: 100,
    keyType: "standard",
    toastOnError: false,
  });
  const virtualKeyOptions = (virtualKeyPage?.data ?? []).map((key) => ({
    value: key.id,
    label: key.name,
  }));

  const createPool = useCreateModelPool();
  const updatePool = useUpdateModelPool();
  const deletePool = useDeleteModelPool();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saving = createPool.isPending || updatePool.isPending;

  const onSubmit = form.handleSubmit((values) => {
    const body: ModelPoolInput = {
      name: values.name.trim(),
      members: values.members.map((member) => ({
        ...member,
        modelId: member.modelId.trim(),
      })),
      virtualApiKeyIds: values.virtualApiKeyIds,
    };
    const onSuccess = (saved: { id: string } | undefined) => {
      if (saved) onSaved(saved.id);
    };
    if (pool) updatePool.mutate({ id: pool.id, body }, { onSuccess });
    else createPool.mutate(body, { onSuccess });
  });

  const memberKeys = members.map(
    (member) => `${member.providerApiKeyId}|${member.modelId.trim()}`,
  );
  const repeated = memberKeys.some(
    (key, index) => memberKeys.indexOf(key) !== index,
  );
  const nextKey =
    sharedKeys.find(
      (key) => !members.some((member) => member.providerApiKeyId === key.id),
    ) ?? sharedKeys[0];
  // One pool per name: the name is what a request asks for.
  const { data: pools = [] } = useModelPools({ toastOnError: false });
  const otherPool = pools.find(
    (other) => other.id !== pool?.id && other.name === name,
  );
  const canSave =
    name.length > 0 &&
    !otherPool &&
    !repeated &&
    members.length > 0 &&
    members.every((member) => member.providerApiKeyId && member.modelId.trim());

  return (
    <form
      onSubmit={onSubmit}
      className="flex min-w-0 flex-col gap-6 rounded-lg border bg-card p-5"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-56 flex-1 gap-1.5">
          <Label htmlFor="pool-name">Model name</Label>
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
                              modelIdsByKey.get(member.providerApiKeyId),
                            ),
                          }
                        : member,
                    ),
                  );
                }}
                disabled={!canEdit}
                placeholder="e.g. glm-5"
                ariaLabel="Model name"
                searchPlaceholder="Search or type a model name"
                allowCustom
                className="w-full max-w-md font-mono"
                items={modelNames.map((value) => ({ value, label: value }))}
              />
            )}
          />
        </div>
        <div className="flex gap-2">
          {pool ? (
            <PermissionButton
              type="button"
              variant="outline"
              permissions={{ llmModel: ["update"] }}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 />
              <span>Delete</span>
            </PermissionButton>
          ) : null}
          <PermissionButton
            type="submit"
            permissions={{ llmModel: ["update"] }}
            disabled={!canSave || saving}
          >
            <span>{pool ? "Save pool" : "Create pool"}</span>
          </PermissionButton>
        </div>
      </div>

      <p className="-mt-3 text-sm text-muted-foreground">
        Clients ask for this name. A request for it is balanced across the
        members below, whichever provider each one is on.
      </p>
      {otherPool ? (
        <InlineNotice>
          <TriangleAlert />
          <span className="font-medium">This name already has a pool</span>
          <InlineNoticeText>Add the members there instead.</InlineNoticeText>
        </InlineNotice>
      ) : null}

      <Step number={1} title="Routing">
        <div className="grid gap-2 sm:grid-cols-2">
          <ModeCard
            selected
            title="Priority, then weight"
            description="Try priority 1 first. Members that share a priority split traffic by weight."
          />
          <ModeCard
            title="Most headroom"
            description="Pick the member furthest from its per-minute limit."
            later
          />
        </div>
      </Step>

      <Step number={2} title="Members">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Priority</th>
                <th className="py-2 pr-3 font-medium">Provider key</th>
                <th className="py-2 pr-3 font-medium">Model ID</th>
                <th className="py-2 pr-3 font-medium">Weight</th>
                <th className="py-2 pr-3 font-medium">On</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 font-medium">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-3 text-sm text-muted-foreground"
                  >
                    Add the provider keys that serve this model, on any
                    provider. Priority 1 takes traffic first; higher numbers are
                    standbys.
                  </td>
                </tr>
              ) : null}
              {fields.map((field, index) => {
                const member = members[index];
                const saved = pool?.members.find(
                  (row) =>
                    row.providerApiKeyId === member?.providerApiKeyId &&
                    row.modelId === member?.modelId,
                );
                const keyModels =
                  modelIdsByKey.get(member?.providerApiKeyId ?? "") ?? [];
                return (
                  <tr key={field.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-3">
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        aria-label="Priority"
                        className="w-16 font-mono"
                        disabled={!canEdit}
                        {...form.register(`members.${index}.priority`, {
                          valueAsNumber: true,
                        })}
                      />
                    </td>
                    <td className="py-2 pr-3">
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
                                suggestModelId(name, modelIdsByKey.get(value)),
                              );
                            }}
                            disabled={!canEdit}
                          >
                            <SelectTrigger
                              className="w-64"
                              aria-label="Provider key"
                            >
                              <SelectValue placeholder="Choose a key" />
                            </SelectTrigger>
                            <SelectContent>
                              {sharedKeys.map((key) => (
                                <SelectItem key={key.id} value={key.id}>
                                  <span className="flex items-center gap-2">
                                    <ProviderName provider={key.provider} />
                                    <span className="text-muted-foreground">
                                      {key.name}
                                    </span>
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <Controller
                        control={form.control}
                        name={`members.${index}.modelId`}
                        render={({ field: modelField }) => (
                          <SearchableSelect
                            value={modelField.value}
                            onValueChange={modelField.onChange}
                            disabled={!canEdit || !member?.providerApiKeyId}
                            placeholder="Model ID"
                            ariaLabel="Member model ID"
                            searchPlaceholder="Search or type a model ID"
                            allowCustom
                            className="w-56 font-mono"
                            items={keyModels.map((value) => ({
                              value,
                              label: value,
                            }))}
                          />
                        )}
                      />
                      {member?.providerApiKeyId &&
                      member.modelId &&
                      !keyModels.includes(member.modelId) ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          This key doesn't list {member.modelId}.
                        </p>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          max={1000}
                          aria-label="Weight"
                          className="w-20 font-mono"
                          disabled={!canEdit}
                          {...form.register(`members.${index}.weight`, {
                            valueAsNumber: true,
                          })}
                        />
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {tierShare(members, index)}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <Controller
                        control={form.control}
                        name={`members.${index}.enabled`}
                        render={({ field: enabledField }) => (
                          <Switch
                            checked={enabledField.value}
                            onCheckedChange={enabledField.onChange}
                            disabled={!canEdit}
                            aria-label="Member on"
                          />
                        )}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <MemberStatus
                        enabled={member?.enabled ?? true}
                        saved={saved ?? null}
                      />
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove member"
                        disabled={!canEdit}
                        onClick={() => remove(index)}
                      >
                        <X />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit || !nextKey}
            onClick={() =>
              nextKey &&
              append({
                providerApiKeyId: nextKey.id,
                modelId: suggestModelId(name, modelIdsByKey.get(nextKey.id)),
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
          {repeated ? (
            <span className="text-xs text-destructive">
              A key and model ID can be a member only once.
            </span>
          ) : null}
          {members.some(
            (member) =>
              keysById.get(member.providerApiKeyId)?.provider === "bedrock",
          ) ? (
            <span className="text-xs text-muted-foreground">
              Anthropic-style clients such as Claude Code skip Bedrock members.
            </span>
          ) : null}
        </div>
      </Step>

      <Step number={3} title="Who can use it">
        <Controller
          control={form.control}
          name="virtualApiKeyIds"
          render={({ field }) => (
            <MultiSelectCombobox
              ariaLabel="Virtual keys that can use this pool"
              options={virtualKeyOptions}
              value={field.value}
              onChange={field.onChange}
              placeholder="Add virtual keys"
              emptyMessage="No virtual keys found."
              className="max-w-xl"
              disabled={!canEdit}
            />
          )}
        />
        <p className="text-sm text-muted-foreground">
          A virtual key reaches this pool only when it is listed here, as it
          reaches a provider key only when mapped to one. Agents and chats reach
          it when their own provider key is a member.
        </p>
      </Step>

      <Step number={4} title="Reliability">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {RELIABILITY_RULES.map((rule) => (
            <div
              key={rule.label}
              className="grid gap-0.5 rounded-md border px-3 py-2"
            >
              <span className="text-xs text-muted-foreground">
                {rule.label}
              </span>
              <span className="text-sm font-medium">{rule.value}</span>
            </div>
          ))}
        </div>
      </Step>

      <DeleteConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this pool?"
        description="Requests for its name go back to the caller's own key."
        isPending={deletePool.isPending}
        onConfirm={async () => {
          if (!pool) return;
          await deletePool.mutateAsync(pool.id);
          setConfirmDelete(false);
          onDeleted();
        }}
      />
    </form>
  );
}

/** What the proxy does today, stated as rules the admin can read. */
const RELIABILITY_RULES = [
  {
    label: "Move to the next member on",
    value: "429, 5xx, timeouts, connection errors, without retrying it",
  },
  {
    label: "Move on from a silent stream",
    value: "No first chunk in 30 s, unless it is the last member",
  },
  {
    label: "Also move on when a key is refused",
    value: "401, 403, or 404 from that key",
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

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-5 place-items-center rounded-full bg-primary text-[11px] text-primary-foreground">
          {number}
        </span>
        <span>{title}</span>
      </h3>
      {children}
    </section>
  );
}

function ModeCard({
  title,
  description,
  selected = false,
  later = false,
}: {
  title: string;
  description: string;
  selected?: boolean;
  later?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid gap-0.5 rounded-md border px-3 py-2",
        selected && "border-foreground ring-1 ring-foreground",
        later && "border-dashed text-muted-foreground",
      )}
      aria-current={selected ? "true" : undefined}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <span>{title}</span>
        {later ? (
          <span className="rounded-sm bg-muted px-1 text-[10px] font-medium uppercase">
            Later
          </span>
        ) : null}
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </div>
  );
}

export function ProviderName({ provider }: { provider: string }) {
  const config = PROVIDER_CONFIG[provider as SupportedProvider];
  return (
    <span className="flex items-center gap-2">
      {config ? (
        <Image
          src={config.icon}
          alt=""
          width={16}
          height={16}
          className="shrink-0 rounded dark:invert"
        />
      ) : null}
      <span>{config?.name ?? provider}</span>
    </span>
  );
}

function toFormValues(pool: ModelPool | null): PoolFormValues {
  return {
    name: pool?.name ?? "",
    members:
      pool?.members.map((member) => ({
        providerApiKeyId: member.providerApiKeyId,
        modelId: member.modelId,
        priority: member.priority,
        weight: member.weight,
        enabled: member.enabled,
      })) ?? [],
    virtualApiKeyIds: pool?.virtualApiKeyIds ?? [],
  };
}

/**
 * The model id a key most likely serves `name` under: the name itself, else
 * the one id that ends with it (Bedrock's `zai.glm-5` for `glm-5`).
 */
function suggestModelId(name: string, keyModels: string[] = []): string {
  if (!name || keyModels.includes(name)) return name;
  const endingWithName = keyModels.filter(
    (modelId) =>
      modelId.endsWith(`.${name}`) ||
      modelId.endsWith(`/${name}`) ||
      modelId.endsWith(`:${name}`),
  );
  return endingWithName.length === 1 ? endingWithName[0] : name;
}

/** A new member goes one priority below the last, as a standby. */
function nextPriority(members: PoolFormValues["members"]): number {
  if (members.length === 0) return 1;
  return Math.min(100, Math.max(...members.map((m) => m.priority || 1)) + 1);
}

/** The member's share of its priority tier, among members that are on. */
function tierShare(members: PoolFormValues["members"], index: number): string {
  const member = members[index];
  if (!member?.enabled) return "";
  const tier = members.filter(
    (other) => other.enabled && other.priority === member.priority,
  );
  if (tier.length < 2) return "";
  const total = tier.reduce((sum, other) => sum + (other.weight || 0), 0);
  if (total <= 0) return "";
  return `${Math.round(((member.weight || 0) / total) * 100)}%`;
}
