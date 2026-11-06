"use client";

import { Loader2, Search } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useUpdateAgentModels } from "@/lib/agent.query";
import { useLlmModels } from "@/lib/llm-models.query";
import { getApiErrorMessage } from "@/lib/utils/api";
import { cn } from "@/lib/utils/tailwind";
import { AgentModelPicker } from "./agent-model-picker";
import type { ModelSelection, RuntimeAgent } from "./runtime-agent";
import { useRuntimeCompatibleKeys } from "./use-runtime-compatible-keys";

/**
 * Gives Agent Runtime agents a model of their own, so the organization's
 * default can move to a model their runtime can't run. One "Apply to all"
 * picker sets every agent; "Change" on a row picks something else for it.
 */
export function UpdateAgentModelsDialog({
  open,
  onOpenChange,
  agents,
  modelName,
  allClaudeCode,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The agents to update: one (from its row) or all of them. */
  agents: RuntimeAgent[];
  /** The default model they can't run. */
  modelName: string;
  /** Every agent runs Claude Code, so the reason can name it. */
  allClaudeCode: boolean;
  /** Called with the ids that now have a model of their own. */
  onSaved: (agentIds: string[]) => void;
}) {
  const [bulk, setBulk] = useState<ModelSelection>(EMPTY);
  const [overrides, setOverrides] = useState<Record<string, ModelSelection>>(
    {},
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const keys = useRuntimeCompatibleKeys(agents);
  const save = useUpdateAgentModels();
  const prefilled = useRef(false);

  const count = agents.length;
  const one = count === 1;
  const single = agents[0];

  // Fresh state every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setBulk(EMPTY);
    setOverrides({});
    setExpandedId(null);
    setQuery("");
    prefilled.current = false;
  }, [open]);

  // Start with the first usable key so the admin only has to pick a model.
  useEffect(() => {
    if (!open || prefilled.current || keys.length === 0) return;
    prefilled.current = true;
    setBulk((current) =>
      current.apiKeyId ? current : { apiKeyId: keys[0].id, modelId: null },
    );
  }, [open, keys]);

  const selectionFor = (agent: RuntimeAgent) => overrides[agent.id] ?? bulk;
  const ready = agents.filter((agent) => isComplete(selectionFor(agent)));
  const overriddenCount = agents.filter((agent) => overrides[agent.id]).length;
  const isDirty = !!bulk.modelId || overriddenCount > 0;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((agent) => agent.name.toLowerCase().includes(q));
  }, [agents, query]);

  const runtimePhrase = allClaudeCode
    ? "which Claude Code can't run"
    : one
      ? "which its runtime can't run"
      : "which their runtime can't run";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (ready.length === 0 || save.isPending) return;
    try {
      const ids = await save.mutateAsync(
        ready.map((agent) => {
          const { apiKeyId, modelId } = selectionFor(agent);
          return {
            agentId: agent.id,
            llmApiKeyId: apiKeyId as string,
            modelId: modelId as string,
          };
        }),
      );
      toast.success(
        ids.length === 1
          ? "Agent model updated"
          : `${ids.length} agents updated`,
      );
      onSaved(ids);
    } catch (error) {
      toast.error("Couldn't update agents", {
        description: getApiErrorMessage(error),
      });
    }
  };

  const saveLabel = one
    ? "Save"
    : ready.length === count
      ? `Save all ${count}`
      : ready.length > 0
        ? `Save ${ready.length}`
        : "Save";

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      size={one ? "small" : "medium"}
      className={one ? undefined : "max-w-xl"}
      isDirty={isDirty && !save.isPending}
      title={
        one && single
          ? `Set a model for ${single.name}`
          : `Update model for ${count} agents`
      }
      description={
        one
          ? `It has no model of its own, so it would inherit ${modelName}, ${runtimePhrase}.`
          : `They have no model of their own, so they'd inherit ${modelName}, ${runtimePhrase}.`
      }
      onSubmit={handleSubmit}
      bodyClassName={one ? undefined : "space-y-5"}
      footerClassName="sm:items-center"
      footer={
        <>
          {!one && (
            <p className="mr-auto text-xs text-muted-foreground tabular-nums">
              {ready.length === 0
                ? "Pick a model to continue"
                : ready.length === count
                  ? `All ${count} ready`
                  : `${ready.length} of ${count} ready · the rest stay as they are`}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={ready.length === 0 || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            {save.isPending ? "Saving..." : saveLabel}
          </Button>
        </>
      }
    >
      {one && single ? (
        <AgentModelPicker
          agents={agents}
          value={bulk}
          onChange={setBulk}
          layout="stack"
          disabled={save.isPending}
        />
      ) : (
        <>
          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-medium">Apply to all</h3>
              <span className="text-xs text-muted-foreground">
                Every agent below uses this unless you change it
              </span>
            </div>
            <AgentModelPicker
              agents={agents}
              value={bulk}
              onChange={setBulk}
              layout="row"
              disabled={save.isPending}
            />
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">
                Agents{" "}
                <span className="font-normal text-muted-foreground tabular-nums">
                  {count}
                  {overriddenCount > 0 && ` · ${overriddenCount} changed`}
                </span>
              </h3>
              {count > SEARCH_THRESHOLD && (
                <div className="relative w-44">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter agents"
                    aria-label="Filter agents"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
              )}
            </div>

            <div className="max-h-[min(19rem,42vh)] overflow-y-auto rounded-md border">
              {visible.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No agents match “{query.trim()}”
                </p>
              ) : (
                <ul className="divide-y">
                  {visible.map((agent) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      bulk={bulk}
                      override={overrides[agent.id]}
                      expanded={expandedId === agent.id}
                      disabled={save.isPending}
                      onToggle={() =>
                        setExpandedId((id) =>
                          id === agent.id ? null : agent.id,
                        )
                      }
                      onOverride={(selection) =>
                        setOverrides((current) => ({
                          ...current,
                          [agent.id]: selection,
                        }))
                      }
                      onReset={() => {
                        setOverrides((current) => {
                          const { [agent.id]: _, ...rest } = current;
                          return rest;
                        });
                        setExpandedId(null);
                      }}
                    />
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      )}
    </StandardFormDialog>
  );
}

// === Internal helpers ===

function AgentRow({
  agent,
  bulk,
  override,
  expanded,
  disabled,
  onToggle,
  onOverride,
  onReset,
}: {
  agent: RuntimeAgent;
  bulk: ModelSelection;
  override: ModelSelection | undefined;
  expanded: boolean;
  disabled: boolean;
  onToggle: () => void;
  onOverride: (selection: ModelSelection) => void;
  onReset: () => void;
}) {
  return (
    <li className={cn(expanded && "bg-muted/40")}>
      <div className="flex min-h-10 items-center gap-3 px-3 py-1.5 text-sm">
        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
        <span className="max-w-[45%] shrink-0 truncate text-right text-xs">
          {override ? (
            isComplete(override) ? (
              <ModelLabel selection={override} />
            ) : (
              <span className="text-muted-foreground">Choose a model</span>
            )
          ) : isComplete(bulk) ? (
            <span className="text-muted-foreground">Same as above</span>
          ) : (
            <span className="text-muted-foreground/60">Not set</span>
          )}
        </span>
        <UnstyledButton
          onClick={onToggle}
          disabled={disabled}
          aria-expanded={expanded}
          className="w-12 shrink-0 text-right text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          {expanded ? "Done" : "Change"}
        </UnstyledButton>
      </div>
      {expanded && (
        <div className="space-y-2 px-3 pt-0.5 pb-3">
          <AgentModelPicker
            agents={[agent]}
            value={override ?? bulk}
            onChange={onOverride}
            layout="row"
            disabled={disabled}
          />
          {override && (
            <UnstyledButton
              onClick={onReset}
              disabled={disabled}
              className="text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground"
            >
              Use the same as above
            </UnstyledButton>
          )}
        </div>
      )}
    </li>
  );
}

/** The chosen model's display name, resolved from that key's model list. */
function ModelLabel({ selection }: { selection: ModelSelection }) {
  const { data: models } = useLlmModels({
    apiKeyId: selection.apiKeyId ?? undefined,
  });
  const model = models?.find((m) => m.dbId === selection.modelId);
  return (
    <span className="text-foreground">
      {model ? (model.displayName ?? model.id) : "Custom model"}
    </span>
  );
}

function isComplete(selection: ModelSelection) {
  return !!selection.apiKeyId && !!selection.modelId;
}

const EMPTY: ModelSelection = { apiKeyId: null, modelId: null };
const SEARCH_THRESHOLD = 8;
