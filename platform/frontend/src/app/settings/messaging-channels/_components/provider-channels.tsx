"use client";

import {
  type archestraApiTypes,
  MESSAGING_CHANNEL_LABELS,
} from "@archestra/shared";
import { Search } from "lucide-react";
import { useState } from "react";
import { AgentSelector } from "@/components/agent-selector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useInternalAgentOptions } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useAllChatOpsBindings,
  useUpdateChatOpsBinding,
} from "@/lib/chatops/chatops.query";
import {
  ChannelDetailsDialog,
  channelDisplayName,
} from "./channel-details-dialog";

type Binding =
  archestraApiTypes.ListChatOpsBindingsResponses["200"]["data"][number];

/**
 * Every channel a provider's bot is in, with the agent that answers there.
 * One place to see and change them, instead of opening each agent's page.
 * Personal chats belong to one person each, so they stay out of the list
 * until asked for.
 */
export function ProviderChannels({
  provider,
}: {
  provider: "ms-teams" | "telegram";
}) {
  const bindings = useAllChatOpsBindings();
  const { data: agents = [] } = useInternalAgentOptions();
  const { data: canEdit } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const update = useUpdateChatOpsBinding();
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState(ALL_AGENTS);
  const [showDms, setShowDms] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);

  const all = (bindings.data?.bindings ?? []).filter(
    (binding) => binding.provider === provider,
  );
  // Teams delivers a message without a mention only once a team owner allowed
  // the bot to read channel messages; until a workspace has sent one,
  // replying to all may silently do nothing there.
  const workspacesWithTraffic = new Set(
    bindings.data?.pages[0]?.workspacesWithUnmentionedTraffic ?? [],
  );
  const dmCount = all.filter((binding) => binding.isDm).length;
  const needle = query.trim().toLowerCase();
  const shown = all.filter(
    (binding) =>
      (showDms || !binding.isDm) &&
      (agentFilter === ALL_AGENTS || binding.agentId === agentFilter) &&
      (!needle ||
        [channelDisplayName(binding), binding.workspaceName ?? ""].some(
          (text) => text.toLowerCase().includes(needle),
        )),
  );
  const details = all.find((binding) => binding.id === detailsId) ?? null;
  const agentFor = (binding: Binding | null) =>
    agents.find((agent) => agent.id === binding?.agentId) ?? null;
  const label = MESSAGING_CHANNEL_LABELS[provider];

  if (bindings.isPending) {
    return <p className="text-sm text-muted-foreground">Loading channels…</p>;
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">
          Channels{" "}
          <span className="font-normal text-muted-foreground">
            {all.length - dmCount}
          </span>
        </h3>
        {all.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search channels…"
                aria-label="Search channels"
                className="w-56 pl-8"
              />
            </div>
            <AgentSelector
              mode="single"
              flat
              compactTrigger
              agents={agents}
              value={agentFilter}
              onValueChange={setAgentFilter}
              sentinelOption={{ value: ALL_AGENTS, label: "All agents" }}
              className="w-48"
            />
            {dmCount > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowDms((value) => !value)}
              >
                {showDms
                  ? "Hide personal chats"
                  : `Show ${dmCount} personal ${dmCount === 1 ? "chat" : "chats"}`}
              </Button>
            )}
          </div>
        )}
      </div>

      {all.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No {label} channels yet. Add the bot to a{" "}
          {provider === "ms-teams" ? "team" : "group"} and @mention it.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No channels match these filters.
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead className="w-[26%]">Agent</TableHead>
                <TableHead className="w-[16%]">Replies</TableHead>
                <TableHead className="w-[12%]">Instructions</TableHead>
                <TableHead className="w-[110px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((binding) => {
                const agent = agentFor(binding);
                const consentUnknown =
                  provider === "ms-teams" &&
                  binding.answerAllMessages &&
                  !binding.isDm &&
                  !!binding.workspaceId &&
                  !workspacesWithTraffic.has(binding.workspaceId);
                return (
                  <TableRow key={binding.id}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">
                          {channelDisplayName(binding)}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {binding.isDm
                            ? "Personal chat"
                            : (binding.workspaceName ??
                              (provider === "ms-teams" ? "Team" : "Group"))}
                        </span>
                        {consentUnknown && (
                          <span className="text-xs text-amber-800 dark:text-amber-300">
                            No message has arrived without a mention yet. A team
                            owner may need to allow the bot to read channel
                            messages.
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {canEdit ? (
                        <AgentSelector
                          mode="single"
                          flat
                          compactTrigger
                          agents={agents}
                          value={binding.agentId ?? ""}
                          onValueChange={(agentId) =>
                            update.mutate({
                              id: binding.id,
                              body: { agentId },
                            })
                          }
                          placeholder="No agent"
                          className="w-full"
                        />
                      ) : (
                        <span>{agent?.name ?? "No agent"}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {binding.answerAllMessages
                        ? "All messages"
                        : "When @mentioned"}
                    </TableCell>
                    <TableCell>
                      {binding.channelInstructions ? "Yes" : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Settings for ${channelDisplayName(binding)}`}
                        onClick={() => setDetailsId(binding.id)}
                      >
                        {canEdit ? "Settings" : "Details"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ChannelDetailsDialog
        binding={details}
        assignedAgent={agentFor(details)}
        open={!!details}
        readOnly={!canEdit}
        isSaving={update.isPending}
        onOpenChange={(open) => {
          if (!open) setDetailsId(null);
        }}
        onSave={async ({ channelInstructions, answerAllMessages }) => {
          if (!details) return;
          const saved = await update.mutateAsync({
            id: details.id,
            body: { channelInstructions, answerAllMessages },
          });
          if (saved) setDetailsId(null);
        }}
      />
    </section>
  );
}

const ALL_AGENTS = "__all__";
