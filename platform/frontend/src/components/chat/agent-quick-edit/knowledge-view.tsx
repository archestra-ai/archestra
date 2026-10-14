"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Database, ExternalLink, Loader2, Search } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUpdateProfile } from "@/lib/agent.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { connectorLabel } from "./connector-label";
import { changeSummary } from "./subagents-view";
import { QuickEditFooter, QuickEditViewHeader } from "./view-header";

type KnowledgeBase =
  archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number];
type Connector =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

export function KnowledgeView({
  agent,
  allKnowledgeBases,
  allConnectors,
  onBack,
}: {
  agent: {
    id: string;
    name: string;
    knowledgeBaseIds?: string[];
    connectorIds?: string[];
  };
  allKnowledgeBases: KnowledgeBase[];
  allConnectors: Connector[];
  onBack: () => void;
}) {
  const updateProfile = useUpdateProfile();
  const [search, setSearch] = useState("");
  const savedKbIds = useMemo(
    () => new Set(agent.knowledgeBaseIds ?? []),
    [agent.knowledgeBaseIds],
  );
  const savedConnectorIds = useMemo(
    () => new Set(agent.connectorIds ?? []),
    [agent.connectorIds],
  );
  const [kbIds, setKbIds] = useState(() => new Set(savedKbIds));
  const [connectorIds, setConnectorIds] = useState(
    () => new Set(savedConnectorIds),
  );
  // Rows keep the order they opened with, so ticking one doesn't move it.
  const initialKbIds = useRef(savedKbIds);
  const initialConnectorIds = useRef(savedConnectorIds);

  const lower = search.toLowerCase();
  const knowledgeBases = allKnowledgeBases
    .filter(
      (kb) =>
        !lower ||
        kb.name.toLowerCase().includes(lower) ||
        kb.description?.toLowerCase().includes(lower),
    )
    .sort(
      (a, b) =>
        Number(initialKbIds.current.has(b.id)) -
        Number(initialKbIds.current.has(a.id)),
    );
  const connectors = allConnectors
    .filter(
      (connector) =>
        !lower ||
        connector.name.toLowerCase().includes(lower) ||
        connector.connectorType.toLowerCase().includes(lower),
    )
    .sort(
      (a, b) =>
        Number(initialConnectorIds.current.has(b.id)) -
        Number(initialConnectorIds.current.has(a.id)),
    );

  const added =
    countMissing(kbIds, savedKbIds) +
    countMissing(connectorIds, savedConnectorIds);
  const removed =
    countMissing(savedKbIds, kbIds) +
    countMissing(savedConnectorIds, connectorIds);
  const hasChanges = added > 0 || removed > 0;

  const save = () =>
    updateProfile.mutate(
      {
        id: agent.id,
        data: {
          knowledgeBaseIds: [...kbIds],
          connectorIds: [...connectorIds],
        },
      },
      { onSuccess: onBack },
    );

  const empty = allKnowledgeBases.length === 0 && allConnectors.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <QuickEditViewHeader
        backLabel={agent.name}
        onBack={onBack}
        title="Knowledge"
      />
      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Database className="size-8 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">No knowledge sources yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a knowledge base or connector to use it here.
            </p>
          </div>
          <a
            href="/knowledge/knowledge-bases"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
          >
            Go to Knowledge
            <ExternalLink className="size-3" />
          </a>
        </div>
      ) : (
        <>
          <div className="relative shrink-0 px-5 pt-4 pb-2">
            <Search className="absolute top-[calc(50%+4px)] left-8 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search knowledge sources"
              aria-label="Search knowledge sources"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pt-1 pb-4">
            {knowledgeBases.length > 0 && (
              <KnowledgeGroup title="Knowledge bases">
                {knowledgeBases.map((kb) => {
                  const types = [
                    ...new Set(
                      (kb.connectors ?? []).map((c) => c.connectorType),
                    ),
                  ];
                  const connectorCount = kb.connectors?.length ?? 0;
                  return (
                    <KnowledgeOption
                      key={kb.id}
                      checked={kbIds.has(kb.id)}
                      saved={savedKbIds.has(kb.id)}
                      onCheckedChange={(checked) =>
                        setKbIds((current) => toggle(current, kb.id, checked))
                      }
                      icon={
                        types[0] ? (
                          <ConnectorTypeIcon
                            type={types[0]}
                            className="size-4"
                          />
                        ) : (
                          <Database className="size-4 text-muted-foreground" />
                        )
                      }
                      name={kb.name}
                      meta={
                        connectorCount > 0
                          ? `${connectorCount} ${connectorCount === 1 ? "connector" : "connectors"} · ${types.map(connectorLabel).join(", ")}`
                          : "No connectors yet"
                      }
                    />
                  );
                })}
              </KnowledgeGroup>
            )}
            {connectors.length > 0 && (
              <KnowledgeGroup title="Single connectors">
                {connectors.map((connector) => (
                  <KnowledgeOption
                    key={connector.id}
                    checked={connectorIds.has(connector.id)}
                    saved={savedConnectorIds.has(connector.id)}
                    onCheckedChange={(checked) =>
                      setConnectorIds((current) =>
                        toggle(current, connector.id, checked),
                      )
                    }
                    icon={
                      <ConnectorTypeIcon
                        type={connector.connectorType}
                        className="size-4"
                      />
                    }
                    name={connector.name}
                    meta={`${connectorLabel(connector.connectorType)} · ${
                      connector.lastSyncAt
                        ? `synced ${formatRelativeTimeFromNow(connector.lastSyncAt)}`
                        : "not synced yet"
                    }`}
                  />
                ))}
              </KnowledgeGroup>
            )}
            {knowledgeBases.length === 0 && connectors.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No knowledge sources match "{search}"
              </p>
            )}
          </div>
        </>
      )}
      {!empty && (
        <QuickEditFooter>
          <span className="text-xs text-muted-foreground">
            {changeSummary(kbIds.size + connectorIds.size, added, removed)}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onBack}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={!hasChanges || updateProfile.isPending}
            >
              {updateProfile.isPending && <Loader2 className="animate-spin" />}
              <span>Save</span>
            </Button>
          </div>
        </QuickEditFooter>
      )}
    </div>
  );
}

function KnowledgeGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function KnowledgeOption({
  checked,
  saved,
  onCheckedChange,
  icon,
  name,
  meta,
}: {
  checked: boolean;
  saved: boolean;
  onCheckedChange: (checked: boolean) => void;
  icon: ReactNode;
  name: string;
  meta: string;
}) {
  return (
    <Label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg border bg-background py-2 pr-3 pl-3 font-normal",
        checked && "border-primary ring-1 ring-primary",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{name}</span>
          {checked && !saved && <Badge variant="secondary">Adding</Badge>}
          {!checked && saved && <Badge variant="destructive">Removing</Badge>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{meta}</div>
      </div>
    </Label>
  );
}

function toggle(current: Set<string>, id: string, checked: boolean) {
  const next = new Set(current);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

function countMissing(from: Set<string>, to: Set<string>) {
  return [...from].filter((id) => !to.has(id)).length;
}
