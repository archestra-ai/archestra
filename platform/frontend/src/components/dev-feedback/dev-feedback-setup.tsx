"use client";

import { Check, Hash, Loader2, Lock, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useDevFeedbackBots,
  useDevFeedbackChannels,
  useSaveDevFeedbackSetup,
} from "@/lib/dev-feedback/dev-feedback.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";

/**
 * First-run setup, opened from the comment button: pick which chatops Slack
 * bot posts the feedback, then the channel. The lists are inline rather than
 * dropdowns, which would open beneath the overlay's layer.
 */
export function DevFeedbackSetupPanel(props: {
  currentChannelName: string | null;
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
    <div className="fixed right-4 bottom-16 z-[2147483001] w-80 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg">
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

function ChannelPicker(props: { botId: string; onSaved: () => void }) {
  const channels = useDevFeedbackChannels(props.botId);
  const save = useSaveDevFeedbackSetup();
  const [search, setSearch] = useState("");
  const [channelId, setChannelId] = useState<string | null>(null);
  const query = search.trim().replace(/^#/, "").toLowerCase();
  const visible = (channels.data ?? []).filter((channel) =>
    channel.name.toLowerCase().includes(query),
  );
  const picked = channels.data?.find((channel) => channel.id === channelId);

  return (
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
      <Button
        size="sm"
        className="mt-2 w-full"
        disabled={!picked || save.isPending}
        onClick={() => {
          if (!picked) return;
          save.mutate(
            { botId: props.botId, channelId: picked.id },
            { onSuccess: props.onSaved },
          );
        }}
      >
        {save.isPending && <Loader2 className="animate-spin" />}
        <span>{picked ? `Post to #${picked.name}` : "Pick a channel"}</span>
      </Button>
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
