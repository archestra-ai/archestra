"use client";

import { Check, Hash, Loader2, Lock, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  useAgentOptionsByIds,
  useAgentOptionsPage,
} from "@/lib/agent-options.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useDevFeedbackBots,
  useDevFeedbackChannels,
  useSaveDevFeedbackSetup,
} from "@/lib/dev-feedback/dev-feedback.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { cn } from "@/lib/utils/tailwind";

/**
 * First-run setup, opened from the comment button: pick which chatops Slack
 * bot posts the feedback, then the channel and optional reviewing agent.
 * Lists stay inline so they cannot open beneath the overlay's layer.
 */
export function DevFeedbackSetupPanel(props: {
  currentChannelName: string | null;
  currentAgentId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: canConfigure, isPending: checkingPermission } =
    useHasPermissions({ organizationSettings: ["update"] });
  const bots = useDevFeedbackBots(canConfigure === true);
  const [pickedBotId, setPickedBotId] = useState<string | null>(null);
  const botId =
    pickedBotId ?? (bots.data?.length === 1 ? bots.data[0].id : null);

  return (
    <div className="fixed right-4 bottom-16 z-[2147483001] max-h-[calc(100dvh-5rem)] w-80 overflow-y-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-sm">UI feedback</p>
          <p className="text-muted-foreground text-xs">
            {props.currentChannelName
              ? `Posting to #${props.currentChannelName}`
              : "Pick where comments are posted"}
          </p>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close"
          onClick={props.onClose}
        >
          <X />
        </Button>
      </div>

      <div className="mt-3">
        {checkingPermission || (canConfigure && bots.isPending) ? (
          <Loading label="Loading Slack bots…" />
        ) : !canConfigure ? (
          <p className="text-sm">
            An admin needs to pick the Slack channel feedback goes to.
          </p>
        ) : bots.data?.length === 0 ? (
          <NoBot />
        ) : (
          <>
            {(bots.data?.length ?? 0) > 1 && (
              <Section title="Post as">
                {bots.data?.map((bot) => (
                  <Option
                    key={bot.id}
                    selected={bot.id === botId}
                    onClick={() => setPickedBotId(bot.id)}
                  >
                    <span className="truncate">{bot.name}</span>
                  </Option>
                ))}
              </Section>
            )}
            {botId && (
              <ChannelPicker
                key={botId}
                botId={botId}
                currentAgentId={props.currentAgentId ?? null}
                onSaved={props.onSaved}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ===

function NoBot() {
  const appName = useAppName();
  return (
    <div className="space-y-2 text-sm">
      <p>
        Feedback posts as an {appName} Slack bot, and none is connected yet.
      </p>
      <Button size="xs" asChild>
        <Link href="/settings/messaging-channels/slack">Set up Slack</Link>
      </Button>
    </div>
  );
}

function ChannelPicker(props: {
  botId: string;
  currentAgentId: string | null;
  onSaved: () => void;
}) {
  const channels = useDevFeedbackChannels(props.botId);
  const save = useSaveDevFeedbackSetup();
  const [search, setSearch] = useState("");
  const [channelId, setChannelId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(props.currentAgentId);
  const query = search.trim().replace(/^#/, "").toLowerCase();
  const visible = (channels.data ?? []).filter((channel) =>
    channel.name.toLowerCase().includes(query),
  );
  const picked = channels.data?.find((channel) => channel.id === channelId);

  return (
    <>
      <Section title="Channel">
        <Input
          autoFocus
          value={search}
          placeholder="Search channels"
          className="h-8"
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="mt-1 max-h-56 overflow-y-auto">
          {channels.isPending && <Loading label="Loading channels…" />}
          {!channels.isPending && visible.length === 0 && (
            <p className="px-2 py-1.5 text-muted-foreground text-xs">
              No channels match.
            </p>
          )}
          {visible.map((channel) => (
            <Option
              key={channel.id}
              selected={channel.id === channelId}
              onClick={() => setChannelId(channel.id)}
            >
              {channel.isPrivate ? (
                <Lock className="size-3.5 shrink-0" />
              ) : (
                <Hash className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{channel.name}</span>
            </Option>
          ))}
        </div>
        <p className="mt-1 text-muted-foreground text-xs">
          Private channels show up once the bot is invited.
        </p>
      </Section>
      {picked && <ReviewAgentPicker value={agentId} onChange={setAgentId} />}
      <Button
        size="sm"
        className="mt-2 w-full"
        disabled={!picked || save.isPending}
        onClick={() => {
          if (!picked) return;
          save.mutate(
            { botId: props.botId, channelId: picked.id, agentId },
            { onSuccess: props.onSaved },
          );
        }}
      >
        {save.isPending && <Loader2 className="animate-spin" />}
        <span>{picked ? `Post to #${picked.name}` : "Pick a channel"}</span>
      </Button>
    </>
  );
}

function ReviewAgentPicker(props: {
  value: string | null;
  onChange: (agentId: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 200);
  const agents = useAgentOptionsPage({
    filters: { agentType: "agent" },
    search: debouncedSearch,
  });
  const selected = useAgentOptionsByIds({
    ids: props.value ? [props.value] : [],
    filters: { agentType: "agent" },
  });
  const rows = agents.data?.pages.flatMap((page) => page.data) ?? [];
  const visible = rows.filter((agent) => Boolean(agent.runtime));
  const current = selected.data?.find((agent) => agent.id === props.value);
  return (
    <Section title="Agent review">
      <Option
        selected={props.value === null}
        onClick={() => props.onChange(null)}
      >
        <span>Post only</span>
      </Option>
      <Input
        aria-label="Search review agents"
        value={search}
        placeholder="Search agents with a runtime"
        className="mt-1 h-8"
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="mt-1 max-h-32 overflow-y-auto">
        {current && !visible.some((agent) => agent.id === current.id) && (
          <Option selected onClick={() => props.onChange(current.id)}>
            <span className="truncate">{current.name}</span>
          </Option>
        )}
        {visible.map((agent) => (
          <Option
            key={agent.id}
            selected={props.value === agent.id}
            onClick={() => props.onChange(agent.id)}
          >
            <span className="truncate">{agent.name}</span>
          </Option>
        ))}
        {agents.isPending && <Loading label="Loading agents…" />}
        {agents.isError && (
          <InlineNotice>
            <TriangleAlert />
            <span className="font-medium">Agents unavailable</span>
            <InlineNoticeText>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => agents.refetch()}
              >
                <span>Retry</span>
              </Button>
            </InlineNoticeText>
          </InlineNotice>
        )}
        {agents.isSuccess && visible.length === 0 && (
          <p className="px-2 py-1.5 text-muted-foreground text-xs">
            No agents with a runtime on this page.
          </p>
        )}
        {agents.hasNextPage && (
          <Button
            size="xs"
            variant="ghost"
            disabled={agents.isFetchingNextPage}
            onClick={() => agents.fetchNextPage()}
          >
            <span>Load more agents</span>
          </Button>
        )}
      </div>
      <p className="mt-1 text-muted-foreground text-xs">
        The agent reviews new feedback and replies in its Slack thread.
      </p>
    </Section>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 first:mt-0">
      <p className="mb-1 font-medium text-muted-foreground text-xs">
        {props.title}
      </p>
      {props.children}
    </div>
  );
}

function Option(props: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <UnstyledButton
      aria-pressed={props.selected}
      onClick={props.onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
        props.selected && "bg-accent",
      )}
    >
      {props.children}
      {props.selected && <Check className="ml-auto size-3.5 shrink-0" />}
    </UnstyledButton>
  );
}

function Loading(props: { label: string }) {
  return (
    <p className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs">
      <Loader2 className="size-3.5 animate-spin" />
      <span>{props.label}</span>
    </p>
  );
}
