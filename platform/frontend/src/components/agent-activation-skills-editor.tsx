"use client";

import { BookOpen } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AvailableSkillsDialog } from "@/components/available-skills-dialog";
import { SkillAccessModeEditor } from "@/components/skill-access-mode-editor";
import {
  SkillSelectionEditor,
  type SkillSelectionItem,
} from "@/components/skill-selection-editor";
import { skillSourceLabel } from "@/components/skill-source-badge";
import { Button } from "@/components/ui/button";
import {
  type AgentActivationSkillReference,
  agentActivationSkillReferenceKey,
} from "@/lib/agent-skill-reference";
import {
  type AgentActivationSkill,
  type AgentActivationSkillPolicy,
  type AgentActivationSkillPolicyInput,
  useAgentActivationSkillPolicy,
  useAgentActivationSkills,
  usePatchAgentActivationSkillPolicy,
} from "@/lib/agent-skills.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

const SKILL_PICKER_PAGE_SIZE = 100;

export interface AgentActivationSkillsEditorRef {
  getCreatePolicy: () => AgentActivationSkillPolicyInput;
  saveChanges: () => Promise<void>;
}

interface AgentActivationSkillsEditorProps {
  agentId?: string;
  environmentId?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
}

interface DraftPolicy {
  mode: "all" | "manual";
  allowedReferences: AgentActivationSkillReference[];
  excludedReferences: AgentActivationSkillReference[];
}

type RuleDisposition = "allow" | "exclude";

/**
 * Internal-agent counterpart to Skills over MCP. It shares the same interaction
 * components, while using activation references and caller-relative candidates.
 */
export const AgentActivationSkillsEditor = forwardRef<
  AgentActivationSkillsEditorRef,
  AgentActivationSkillsEditorProps
>(function AgentActivationSkillsEditor(
  { agentId, environmentId, onDirtyChange, onReadyChange },
  ref,
) {
  const policyQuery = useAgentActivationSkillPolicy(agentId);
  const patchPolicy = usePatchAgentActivationSkillPolicy();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const candidatesQuery = useAgentActivationSkills({
    agentId,
    environmentId,
    view: "eligible",
    limit: SKILL_PICKER_PAGE_SIZE,
    offset: 0,
  });
  const searchQuery = useAgentActivationSkills({
    agentId,
    environmentId,
    view: "eligible",
    limit: SKILL_PICKER_PAGE_SIZE,
    offset: 0,
    search: debouncedSearch || undefined,
    enabled: debouncedSearch.length > 0,
  });
  const [draft, setDraft] = useState<DraftPolicy>(() => emptyPolicy());
  const [discardUnavailable, setDiscardUnavailable] = useState<
    RuleDisposition[]
  >([]);
  const initializedRevision = useRef<number | null>(agentId ? null : 0);
  const synchronizedPolicy = useRef<AgentActivationSkillPolicy | null>(null);
  const reconciledEnvironment = useRef(environmentId ?? null);

  useEffect(() => {
    if (!agentId || !policyQuery.data) return;
    if (initializedRevision.current === policyQuery.data.revision) return;
    const previous = synchronizedPolicy.current;
    synchronizedPolicy.current = policyQuery.data;
    initializedRevision.current = policyQuery.data.revision;
    setDraft((current) =>
      previous && policyChanged(previous, current) ? current : policyQuery.data,
    );
  }, [agentId, policyQuery.data]);

  useEffect(() => {
    if (
      agentId ||
      candidatesQuery.isFetching ||
      !candidatesQuery.isSuccess ||
      candidatesQuery.data?.pagination.hasNext ||
      reconciledEnvironment.current === (environmentId ?? null)
    ) {
      return;
    }
    const visibleKeys = new Set(
      (candidatesQuery.data?.data ?? []).map((skill) =>
        agentActivationSkillReferenceKey(skill.reference),
      ),
    );
    setDraft((current) => ({
      ...current,
      allowedReferences: current.allowedReferences.filter((reference) =>
        visibleKeys.has(agentActivationSkillReferenceKey(reference)),
      ),
      excludedReferences: current.excludedReferences.filter((reference) =>
        visibleKeys.has(agentActivationSkillReferenceKey(reference)),
      ),
    }));
    reconciledEnvironment.current = environmentId ?? null;
  }, [
    agentId,
    candidatesQuery.data,
    candidatesQuery.isFetching,
    candidatesQuery.isSuccess,
    environmentId,
  ]);

  const policyReady = !agentId || policyQuery.isSuccess;
  const candidatesReady = candidatesQuery.isSuccess;
  const ready = policyReady && candidatesReady;
  const failed =
    (agentId ? policyQuery.isError : false) || candidatesQuery.isError;
  const searchFailed = debouncedSearch.length > 0 && searchQuery.isError;
  const dirty = policyReady
    ? policyChanged(policyQuery.data ?? emptyPolicy(), draft) ||
      discardUnavailable.length > 0
    : false;

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => onReadyChange?.(ready), [onReadyChange, ready]);

  const rememberedSkills = useRememberedActivationSkills(
    [...draft.allowedReferences, ...draft.excludedReferences],
    [
      candidatesQuery.data?.data,
      searchQuery.data?.data,
      policyQuery.data?.allowedSkills,
      policyQuery.data?.excludedSkills,
    ],
  );
  const candidates = useMemo(
    () =>
      mergeSkillsByReference(
        candidatesQuery.data?.data,
        searchQuery.data?.data,
        policyQuery.data?.allowedSkills,
        policyQuery.data?.excludedSkills,
        rememberedSkills,
      ),
    [
      candidatesQuery.data,
      searchQuery.data,
      policyQuery.data?.allowedSkills,
      policyQuery.data?.excludedSkills,
      rememberedSkills,
    ],
  );
  const items = candidates.map(toSelectionItem);
  const allowedIds = draft.allowedReferences.map(
    agentActivationSkillReferenceKey,
  );
  const excludedIds = draft.excludedReferences.map(
    agentActivationSkillReferenceKey,
  );
  const referencesByKey = new Map(
    candidates.map((skill) => [
      agentActivationSkillReferenceKey(skill.reference),
      skill.reference,
    ]),
  );

  const updateReferences = (
    disposition: "allow" | "exclude",
    selectedIds: string[],
  ) => {
    const references = selectedIds.flatMap((id) => {
      const reference = referencesByKey.get(id);
      return reference ? [reference] : [];
    });
    setDraft((current) =>
      disposition === "allow"
        ? { ...current, allowedReferences: references }
        : { ...current, excludedReferences: references },
    );
  };

  useImperativeHandle(
    ref,
    () => ({
      getCreatePolicy: () => {
        if (agentId) {
          throw new Error("Create policy requested for an existing agent");
        }
        if (!candidatesReady) {
          throw new Error(
            failed
              ? "Could not load skills. Try reopening this page."
              : "Skills are still loading. Try again in a moment.",
          );
        }
        return draft;
      },
      saveChanges: async () => {
        if (!agentId) return;
        const saved = policyQuery.data;
        if (!saved || !ready) {
          throw new Error(
            failed
              ? "Could not load the agent's skills. Try reopening this page."
              : "The agent's skills are still loading. Try again in a moment.",
          );
        }
        const operations = buildOperations(saved, draft);
        if (
          operations.length === 0 &&
          saved.mode === draft.mode &&
          discardUnavailable.length === 0
        ) {
          return;
        }
        await patchPolicy.mutateAsync({
          agentId,
          patch: {
            expectedRevision: saved.revision,
            ...(saved.mode !== draft.mode && { mode: draft.mode }),
            ...(operations.length > 0 && { operations }),
            ...(discardUnavailable.length > 0 && { discardUnavailable }),
          },
        });
        setDiscardUnavailable([]);
      },
    }),
    [
      agentId,
      candidatesReady,
      discardUnavailable,
      draft,
      failed,
      patchPolicy,
      policyQuery.data,
      ready,
    ],
  );

  if (failed) {
    return (
      <p className="text-sm text-destructive">
        <span>
          Could not load the agent&apos;s skills. Close and reopen to try again;
          the saved policy stays unchanged.
        </span>
      </p>
    );
  }
  if (!ready) {
    return (
      <p className="text-sm text-muted-foreground">
        <span>Loading agent skills…</span>
      </p>
    );
  }
  const savedHiddenAllowedCount = policyQuery.data?.hiddenAllowedCount ?? 0;
  const savedHiddenExcludedCount = policyQuery.data?.hiddenExcludedCount ?? 0;
  const hiddenAllowedCount = discardUnavailable.includes("allow")
    ? 0
    : savedHiddenAllowedCount;
  const hiddenExcludedCount = discardUnavailable.includes("exclude")
    ? 0
    : savedHiddenExcludedCount;
  const searchPending =
    search !== debouncedSearch ||
    searchQuery.isFetching ||
    candidatesQuery.isFetching;

  return (
    <div className="space-y-3">
      {!candidatesQuery.data?.enabled && (
        <p className="text-xs text-muted-foreground">
          Skill discovery is not enabled for this agent. This policy still
          controls skills attached to chat or invoked through delegation.
        </p>
      )}
      {searchFailed && (
        <p className="text-xs text-destructive">
          Could not search the full skill catalog. Clear the search and try
          again.
        </p>
      )}
      {(savedHiddenAllowedCount > 0 || savedHiddenExcludedCount > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {savedHiddenAllowedCount > 0 && (
            <UnavailableRulesButton
              disposition="allow"
              count={savedHiddenAllowedCount}
              discarding={discardUnavailable.includes("allow")}
              onToggle={() =>
                setDiscardUnavailable((current) =>
                  toggleDisposition(current, "allow"),
                )
              }
            />
          )}
          {savedHiddenExcludedCount > 0 && (
            <UnavailableRulesButton
              disposition="exclude"
              count={savedHiddenExcludedCount}
              discarding={discardUnavailable.includes("exclude")}
              onToggle={() =>
                setDiscardUnavailable((current) =>
                  toggleDisposition(current, "exclude"),
                )
              }
            />
          )}
        </div>
      )}
      <SkillAccessModeEditor
        mode={draft.mode}
        onModeChange={(mode) => setDraft((current) => ({ ...current, mode }))}
        summary={policySummary({
          draft,
          hiddenAllowedCount,
          hiddenExcludedCount,
        })}
        availableSkillsView={
          <AvailableSkillsDialog
            source={{ kind: "agent", agentId, environmentId }}
          />
        }
        allEditor={
          <div className="space-y-2">
            <p className="pt-1 text-xs text-muted-foreground">
              Every skill available to the person using this agent can be
              loaded, except the skills excluded below. Newly available skills
              are included automatically.
            </p>
            <SkillSelectionEditor
              items={items}
              selectedIds={excludedIds}
              onSelectionChange={(ids) => updateReferences("exclude", ids)}
              tone="exclude"
              onSearchChange={setSearch}
              isSearching={searchPending}
              placeholder="Search skills to exclude..."
            />
          </div>
        }
        manualEditor={
          <div className="space-y-2">
            <p className="pt-1 text-xs text-muted-foreground">
              Only the skills assigned below can be loaded. A person using the
              agent must still have access to each skill.
            </p>
            <SkillSelectionEditor
              items={items}
              selectedIds={allowedIds}
              onSelectionChange={(ids) => updateReferences("allow", ids)}
              onSearchChange={setSearch}
              isSearching={searchPending}
            />
          </div>
        }
      />
    </div>
  );
});

function UnavailableRulesButton({
  disposition,
  count,
  discarding,
  onToggle,
}: {
  disposition: RuleDisposition;
  count: number;
  discarding: boolean;
  onToggle: () => void;
}) {
  const kind = disposition === "allow" ? "allowed" : "excluded";
  return (
    <Button type="button" variant="outline" size="sm" onClick={onToggle}>
      {discarding ? "Keep" : "Remove"} {count} unavailable {kind}{" "}
      {count === 1 ? "skill" : "skills"}
    </Button>
  );
}

function toggleDisposition(
  current: RuleDisposition[],
  disposition: RuleDisposition,
) {
  return current.includes(disposition)
    ? current.filter((item) => item !== disposition)
    : [...current, disposition];
}

function emptyPolicy(): DraftPolicy {
  return { mode: "all", allowedReferences: [], excludedReferences: [] };
}

function mergeSkillsByReference(
  ...sources: Array<readonly AgentActivationSkill[] | undefined>
) {
  const byReference = new Map<string, AgentActivationSkill>();
  for (const source of sources) {
    for (const skill of source ?? []) {
      const key = agentActivationSkillReferenceKey(skill.reference);
      if (!byReference.has(key)) byReference.set(key, skill);
    }
  }
  return [...byReference.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function useRememberedActivationSkills(
  selectedReferences: AgentActivationSkillReference[],
  sources: Array<readonly AgentActivationSkill[] | undefined>,
) {
  const remembered = useRef(new Map<string, AgentActivationSkill>());
  const snapshot = useRef<AgentActivationSkill[]>([]);
  const selected = new Set(
    selectedReferences.map(agentActivationSkillReferenceKey),
  );
  let changed = false;

  for (const source of sources) {
    for (const skill of source ?? []) {
      const key = agentActivationSkillReferenceKey(skill.reference);
      if (!selected.has(key) || remembered.current.get(key) === skill) continue;
      remembered.current.set(key, skill);
      changed = true;
    }
  }
  for (const key of remembered.current.keys()) {
    if (selected.has(key)) continue;
    remembered.current.delete(key);
    changed = true;
  }
  if (changed) snapshot.current = [...remembered.current.values()];
  return snapshot.current;
}

function toSelectionItem(skill: AgentActivationSkill): SkillSelectionItem {
  const source = skillSourceLabel(skill.reference.source);
  const provider = skill.providerName
    ? `${skill.providerName} · ${source}`
    : source;
  const activationIdentity =
    skill.activationName === skill.name ? null : skill.activationName;
  const exactIdentity = selectionIdentity(skill);
  const chipBadge = [skillScopeLabel(skill.scope), exactIdentity]
    .filter(Boolean)
    .join(" · ");
  return {
    id: agentActivationSkillReferenceKey(skill.reference),
    name: skill.name,
    description: skill.description,
    searchText: [skill.activationName, skill.providerName, source]
      .filter(Boolean)
      .join(" "),
    badge: [
      provider,
      skillScopeLabel(skill.scope),
      activationIdentity,
      skill.reference.source === "native" ? exactIdentity : null,
    ]
      .filter(Boolean)
      .join(" · "),
    chipBadge,
    removeLabel: `Remove ${skill.name} (${chipBadge})`,
    icon: <BookOpen className="h-3.5 w-3.5 shrink-0" />,
  };
}

function selectionIdentity(skill: AgentActivationSkill): string {
  switch (skill.reference.source) {
    case "native":
      return skill.reference.skillId.slice(0, 8);
    case "plugin":
    case "external_mcp":
      return skill.activationName;
  }
}

function skillScopeLabel(scope: AgentActivationSkill["scope"]): string {
  switch (scope) {
    case "personal":
      return "Personal";
    case "team":
      return "Team";
    case "org":
      return "Organization";
  }
}

function policyChanged(saved: DraftPolicy, draft: DraftPolicy) {
  return (
    saved.mode !== draft.mode ||
    !sameReferences(saved.allowedReferences, draft.allowedReferences) ||
    !sameReferences(saved.excludedReferences, draft.excludedReferences)
  );
}

function sameReferences(
  left: AgentActivationSkillReference[],
  right: AgentActivationSkillReference[],
) {
  const leftKeys = left.map(agentActivationSkillReferenceKey).sort();
  const rightKeys = right.map(agentActivationSkillReferenceKey).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function buildOperations(
  saved: AgentActivationSkillPolicy,
  draft: DraftPolicy,
) {
  return [
    ...diffReferences(
      "allow",
      saved.allowedReferences,
      draft.allowedReferences,
    ),
    ...diffReferences(
      "exclude",
      saved.excludedReferences,
      draft.excludedReferences,
    ),
  ];
}

function diffReferences(
  disposition: "allow" | "exclude",
  saved: AgentActivationSkillReference[],
  draft: AgentActivationSkillReference[],
) {
  const savedByKey = new Map(
    saved.map((reference) => [
      agentActivationSkillReferenceKey(reference),
      reference,
    ]),
  );
  const draftByKey = new Map(
    draft.map((reference) => [
      agentActivationSkillReferenceKey(reference),
      reference,
    ]),
  );
  return [
    ...[...draftByKey].flatMap(([key, reference]) =>
      savedByKey.has(key)
        ? []
        : [{ op: "add" as const, disposition, reference }],
    ),
    ...[...savedByKey].flatMap(([key, reference]) =>
      draftByKey.has(key)
        ? []
        : [{ op: "remove" as const, disposition, reference }],
    ),
  ];
}

function policySummary(params: {
  draft: DraftPolicy;
  hiddenAllowedCount: number;
  hiddenExcludedCount: number;
}) {
  if (params.draft.mode === "all") {
    const count =
      params.draft.excludedReferences.length + params.hiddenExcludedCount;
    return count === 0
      ? "All available skills"
      : `All available skills except ${count}`;
  }
  const count =
    params.draft.allowedReferences.length + params.hiddenAllowedCount;
  return `${count} assigned ${count === 1 ? "skill" : "skills"}`;
}
