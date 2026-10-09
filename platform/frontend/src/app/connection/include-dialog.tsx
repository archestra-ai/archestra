"use client";

// "Choose what to include": the one place to shape a setup. The gateway the
// agent connects to, then what joins its tools: skills, plugins (all of them
// or only some), and the LLM proxy. Changes apply as they're made; the
// command or prompt behind the dialog follows.

import { BookOpen, Cpu, Info, Puzzle, Wrench, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentSelector } from "@/components/agent-selector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import type { ConnectClient } from "./clients";
import type { ConnectChoices, ConnectPicks } from "./connect-choices";
import type { ConnectPageData } from "./connect-page-data";
import { fmt, plural } from "./connect-page-parts";
import { PluginPickPane } from "./plugin-pick-pane";

/** One change to the setup; the page saves switches and picks together. */
export interface IncludeChange {
  choices?: Partial<ConnectChoices>;
  picks?: Partial<ConnectPicks>;
}

export function IncludeDialog({
  open,
  onOpenChange,
  data,
  client,
  choices,
  picks,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: ConnectPageData;
  client: ConnectClient;
  choices: ConnectChoices;
  picks: ConnectPicks;
  onChange: (change: IncludeChange) => void;
}) {
  const parts = data.partsFor(client);
  const servers = data.servers.length;
  const tools = data.totalTools;
  const skills = data.skills.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose what to include</DialogTitle>
          <DialogDescription>
            What {client.label} gets when it connects. The setup follows your
            changes.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="divide-y py-0">
          {data.gateway && (
            <Section
              icon={<Wrench />}
              title="MCP gateway"
              sub={`${fmt(servers)} MCP ${plural(servers, "server")}, ${fmt(tools)} ${plural(tools, "tool")}. Tools are always included.`}
            >
              {data.gateways.length > 1 ? (
                <AgentSelector
                  mode="single"
                  flat
                  className="w-full"
                  agents={data.gateways}
                  value={data.gateway.id}
                  onValueChange={(id) =>
                    onChange({
                      picks: {
                        gatewayId: id === data.defaultGatewayId ? null : id,
                      },
                    })
                  }
                  placeholder="Select gateway"
                  searchPlaceholder="Search gateways…"
                />
              ) : (
                <p className="text-sm font-medium">{data.gateway.name}</p>
              )}
            </Section>
          )}

          {parts.skills && (
            <Section
              icon={<BookOpen />}
              title="Skills"
              htmlFor="include-skills"
              sub={
                choices.skills
                  ? `${fmt(skills)} ${plural(skills, "skill")}, loaded when a task needs one`
                  : `Off. ${client.label} gets none of the ${fmt(skills)} ${plural(skills, "skill")}.`
              }
              control={
                <Switch
                  id="include-skills"
                  checked={choices.skills}
                  onCheckedChange={(v) => onChange({ choices: { skills: v } })}
                />
              }
            />
          )}

          {parts.plugins && (
            <PluginsSection
              data={data}
              client={client}
              choices={choices}
              picks={picks}
              onChange={onChange}
            />
          )}

          {parts.proxy && (
            <Section
              icon={<Cpu />}
              title="LLM proxy"
              htmlFor="include-proxy"
              sub={
                choices.proxy
                  ? "Model requests go through the LLM proxy"
                  : `Off. ${client.label} calls its model provider directly.`
              }
              control={
                <Switch
                  id="include-proxy"
                  checked={choices.proxy}
                  onCheckedChange={(v) => onChange({ choices: { proxy: v } })}
                />
              }
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Picked plugins shown as chips before the rest fold into "+N more".
const CHIP_LIMIT = 6;

/**
 * All plugins (including ones approved later) or only some, picked in a pane
 * over the dialog. The section only ever shows the choice and a capped row of
 * chips, so it doesn't grow with the plugin count.
 */
function PluginsSection({
  data,
  client,
  choices,
  picks,
  onChange,
}: {
  data: ConnectPageData;
  client: ConnectClient;
  choices: ConnectChoices;
  picks: ConnectPicks;
  onChange: (change: IncludeChange) => void;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [paneOpen, setPaneOpen] = useState(false);
  // The last picks, so All and then Only these again doesn't lose them.
  const [remembered, setRemembered] = useState<string[] | null>(null);
  useEffect(() => {
    setContainer(
      sectionRef.current?.closest<HTMLElement>("[data-slot=dialog-content]") ??
        null,
    );
  }, []);

  const offered = data.pluginsFor(client);
  const total = offered.length;
  const mode = picks.pluginIds === null ? "all" : "only";
  const picked = data.keptPlugins(client, picks.pluginIds);
  const pickedIds = new Set(picked.map((p) => p.id));
  // Picking none is leaving plugins out.
  const on = choices.plugins && picked.length > 0;
  const setPicked = (ids: ReadonlySet<string>) =>
    onChange({
      picks: {
        pluginIds: offered.filter((p) => ids.has(p.id)).map((p) => p.id),
      },
    });

  const setOn = (next: boolean) =>
    onChange({
      choices: { plugins: next },
      // Back on with nothing picked: start again from every plugin.
      ...(next && picked.length === 0 ? { picks: { pluginIds: null } } : {}),
    });
  const setMode = (next: string) => {
    if (next === "all") {
      if (mode === "only" && picked.length > 0)
        setRemembered(picked.map((p) => p.id));
      onChange({ picks: { pluginIds: null } });
      return;
    }
    if (remembered?.length) {
      onChange({ picks: { pluginIds: remembered } });
      return;
    }
    onChange({ picks: { pluginIds: [] } });
    setPaneOpen(true);
  };
  const remove = (id: string) => {
    const next = new Set(pickedIds);
    next.delete(id);
    setPicked(next);
  };

  const shown = picked.slice(0, CHIP_LIMIT);
  const hidden = picked.length - shown.length;

  return (
    <section ref={sectionRef} className="space-y-3 py-4">
      <SectionHeader
        icon={<Puzzle />}
        title="Plugins"
        htmlFor="include-plugins"
        sub={
          !on
            ? `Off. ${client.label} gets none of the ${fmt(total)} ${plural(total, "plugin")} your org approved.`
            : mode === "only"
              ? `${fmt(picked.length)} of ${fmt(total)} ${plural(total, "plugin")} your org approved for ${client.label}`
              : `All ${fmt(total)} ${plural(total, "plugin")} your org approved for ${client.label}`
        }
        control={
          <Switch id="include-plugins" checked={on} onCheckedChange={setOn} />
        }
      />

      {choices.plugins && (
        <div className="space-y-3">
          <RadioGroup
            value={mode}
            onValueChange={setMode}
            className="grid-cols-2 gap-2"
            aria-label="Which plugins"
          >
            <ModeCard
              value="all"
              title="All plugins"
              sub="Includes plugins approved later"
            />
            <ModeCard
              value="only"
              title="Only these"
              sub="New plugins stay out"
            />
          </RadioGroup>

          {mode === "only" && picked.length === 0 && (
            <InlineNotice variant="neutral">
              <Info />
              <span className="font-medium">No plugins picked</span>
              <InlineNoticeText>Plugins are off.</InlineNoticeText>
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                onClick={() => setPaneOpen(true)}
              >
                Pick plugins
              </Button>
            </InlineNotice>
          )}

          {mode === "only" && picked.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border px-3 py-2.5">
              <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {shown.map((p) => (
                  <li key={p.id}>
                    <Badge variant="secondary" className="gap-1 pr-1">
                      <span className="max-w-40 truncate">{p.name}</span>
                      <UnstyledButton
                        aria-label={`Remove ${p.name}`}
                        className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground [&>svg]:size-3"
                        onClick={() => remove(p.id)}
                      >
                        <X />
                      </UnstyledButton>
                    </Badge>
                  </li>
                ))}
                {hidden > 0 && (
                  <li>
                    <UnstyledButton
                      className="rounded-full"
                      onClick={() => setPaneOpen(true)}
                    >
                      <Badge variant="outline" className="hover:bg-accent">
                        <span>+{hidden} more</span>
                      </Badge>
                    </UnstyledButton>
                  </li>
                )}
              </ul>
              <Button
                size="xs"
                variant="ghost"
                className="-my-0.5 shrink-0"
                onClick={() => setPaneOpen(true)}
              >
                Edit
              </Button>
            </div>
          )}
        </div>
      )}

      {paneOpen &&
        container &&
        createPortal(
          <PluginPickPane
            container={container}
            clientLabel={client.label}
            plugins={offered}
            pickedIds={pickedIds}
            onToggle={(id, keep) => {
              const next = new Set(pickedIds);
              if (keep) next.add(id);
              else next.delete(id);
              setPicked(next);
            }}
            onClear={() => setPicked(new Set())}
            onClose={() => setPaneOpen(false)}
          />,
          container,
        )}
    </section>
  );
}

function ModeCard({
  value,
  title,
  sub,
}: {
  value: string;
  title: string;
  sub: string;
}) {
  const id = `include-plugins-${value}`;
  return (
    <label
      htmlFor={id}
      className={cn(
        radioCardClass(),
        "flex cursor-pointer items-start gap-2.5 rounded-lg p-3",
      )}
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{sub}</span>
      </span>
    </label>
  );
}

function Section({
  children,
  ...header
}: Parameters<typeof SectionHeader>[0] & { children?: ReactNode }) {
  return (
    <section className="space-y-3 py-4">
      <SectionHeader {...header} />
      {children}
    </section>
  );
}

function SectionHeader({
  icon,
  title,
  sub,
  htmlFor,
  control,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  /** The switch the title labels. */
  htmlFor?: string;
  control?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/40 text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <label
        htmlFor={htmlFor}
        className={cn("min-w-0 flex-1", htmlFor && "cursor-pointer")}
      >
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-muted-foreground">{sub}</span>
      </label>
      {control}
    </div>
  );
}
