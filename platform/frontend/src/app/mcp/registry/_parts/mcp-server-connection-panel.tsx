"use client";

import type { CreatedBy } from "@archestra/shared";
import {
  ArrowLeftRight,
  Boxes,
  Check,
  ChevronDown,
  Container,
  Copy,
  Globe,
  MonitorSmartphone,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { CreatedByCell } from "@/components/created-by-cell";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils/tailwind";

/** Everything the connection panel states about a server; absent fields are omitted. */
export type McpServerSpec = {
  serverType: "builtin" | "local" | "remote";
  hosting: string;
  environment: string | null;
  serverUrl?: string;
  /** A local server's launch command and its arguments, as passed to the process. */
  command?: string[];
  transport?: string;
  /** Port and path of a streamable-HTTP server, e.g. `8080/mcp`. */
  transportDetail?: string;
  /** Headline and explanation, e.g. "Multi-tenant" / "One shared deployment". */
  deployment?: { label: string; detail: string };
  dockerImage?: string;
  auth: string;
  createdBy: CreatedBy | null;
  toolCount: number;
  interactiveTools: boolean;
  skillCount?: number;
};

/**
 * What the server runs or connects to, and how it is deployed. The target
 * (URL, image or launch command) leads in a terminal-like well that keeps a
 * long command to one line until asked; the operational facts sit in a side
 * panel that stacks underneath when there is no room. Each fact shows once.
 */
export function McpServerConnectionPanel({ spec }: { spec: McpServerSpec }) {
  const target = targetOf(spec);
  const facts = factsOf(spec, target);
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-wrap gap-px overflow-hidden rounded-md border bg-border"
    >
      <h2 id={headingId} className="sr-only">
        Connection
      </h2>
      {/* Side by side when there is room, stacked otherwise; the 1px gap over
          the border colour draws the hairline either way. */}
      <div
        className="flex min-w-0 items-start gap-4 bg-background p-5"
        style={{ flex: "999 1 28rem" }}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground [&>svg]:size-[18px]">
          {target.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {target.label}
          </div>
          {target.well ? (
            <CodeWell well={target.well} />
          ) : (
            <div className="mt-1 text-base leading-snug text-foreground">
              {target.primary}
            </div>
          )}
          {target.caption && (
            <div
              className={cn(
                "mt-2 truncate text-xs text-muted-foreground",
                target.captionMono && "font-mono",
              )}
              title={target.caption}
            >
              {target.caption}
            </div>
          )}
          <Tags spec={spec} showTransport={!target.statesTransport} />
        </div>
      </div>

      {facts.length > 0 && (
        <div
          className="flex min-w-0 bg-background"
          style={{ flex: "1 1 17rem" }}
        >
          <dl className="grid w-full grid-cols-[auto_minmax(0,1fr)] content-start gap-x-6 gap-y-4 bg-muted/30 p-5 text-sm">
            {facts.map((fact) => (
              <div key={fact.label} className="contents">
                <dt className="text-xs leading-5 text-muted-foreground">
                  {fact.label}
                </dt>
                <dd className="min-w-0 leading-5 text-foreground">
                  <div className="truncate">{fact.value}</div>
                  {fact.detail && (
                    <div className="truncate text-xs text-muted-foreground">
                      {fact.detail}
                    </div>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}

// ===

type Well = {
  line: ReactNode;
  copy: string;
  prompt: boolean;
  /** Present for commands: what the expanded view lays out. */
  argv?: string[];
};

type Target = {
  label: string;
  icon: ReactNode;
  well?: Well;
  primary?: ReactNode;
  caption?: string;
  captionMono?: boolean;
  /** The headline already names the hosting, so the facts must not. */
  statesHosting: boolean;
  /** The headline already names the transport, so the tags must not. */
  statesTransport: boolean;
};

function targetOf(spec: McpServerSpec): Target {
  if (spec.serverUrl) {
    const match = spec.serverUrl.match(/^([a-z]+:\/\/)(.*)$/i);
    return {
      label: "Server URL",
      icon: <Globe />,
      well: {
        line: match ? (
          <>
            <span className="text-muted-foreground">{match[1]}</span>
            {match[2]}
          </>
        ) : (
          spec.serverUrl
        ),
        copy: spec.serverUrl,
        prompt: false,
      },
      statesHosting: false,
      statesTransport: false,
    };
  }
  if (spec.dockerImage) {
    const { repo, ref } = splitImage(spec.dockerImage);
    return {
      label: "Image",
      icon: <Container />,
      well: { line: repo, copy: spec.dockerImage, prompt: false },
      caption: ref,
      captionMono: true,
      statesHosting: false,
      statesTransport: false,
    };
  }
  if (spec.serverType === "builtin") {
    return {
      label: "Built in",
      icon: <Boxes />,
      primary: spec.hosting,
      caption: "Nothing to deploy or connect",
      statesHosting: true,
      statesTransport: true,
    };
  }
  if (spec.command?.length) {
    const [program, ...rest] = spec.command;
    const restLine = rest.map(quoteArg).join(" ");
    return {
      label: "Command",
      icon: <SquareTerminal />,
      well: {
        line: (
          <>
            {quoteArg(program)}
            {restLine && (
              <span className="text-muted-foreground"> {restLine}</span>
            )}
          </>
        ),
        copy: spec.command.map(quoteArg).join(" "),
        prompt: true,
        argv: spec.command,
      },
      caption: "Runs on the default MCP base image",
      statesHosting: false,
      statesTransport: false,
    };
  }
  return {
    label: "Runtime",
    icon: <SquareTerminal />,
    primary: spec.transport
      ? `${spec.transport} · runs in a managed pod`
      : spec.hosting,
    statesHosting: true,
    statesTransport: true,
  };
}

function factsOf(spec: McpServerSpec, target: Target) {
  const facts: { label: string; value: ReactNode; detail?: string }[] = [];
  if (!target.statesHosting) {
    facts.push({ label: "Hosting", value: spec.hosting });
  }
  if (spec.environment) {
    facts.push({ label: "Environment", value: spec.environment });
  }
  if (spec.deployment) {
    facts.push({
      label: "Deployment",
      value: spec.deployment.label,
      detail: spec.deployment.detail,
    });
  }
  if (spec.serverType !== "builtin") {
    facts.push({ label: "Auth", value: spec.auth });
  }
  if (spec.createdBy) {
    facts.push({
      label: "Created by",
      value: (
        <CreatedByCell
          createdBy={spec.createdBy}
          showServiceAccountBadge={false}
          className="inline-flex gap-1.5"
        />
      ),
      detail:
        spec.createdBy.type === "service_account"
          ? "Service account"
          : undefined,
    });
  }
  return facts;
}

/**
 * A terminal-like line, truncated until the reader asks for all of it. The
 * full view breaks a command into its arguments, unescaped, so a quoted
 * script reads as the script it is; copy always takes the exact command.
 */
function CodeWell({ well }: { well: Well }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const lineRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = lineRef.current;
    if (el) setOverflows(el.scrollWidth > el.clientWidth + 1);
  }, []);

  useLayoutEffect(() => {
    const el = lineRef.current;
    if (!el || expanded) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, measure]);

  const canExpand = !!well.argv && (overflows || expanded);

  return (
    <div className="mt-1.5 overflow-hidden rounded-md border bg-muted/50 dark:bg-black/40">
      <div className="flex min-w-0 items-center gap-2 py-1.5 pr-1.5 pl-3">
        {expanded && well.argv ? (
          <div className="min-w-0 flex-1 py-1 text-xs leading-6 text-muted-foreground">
            Full command, one step per line
          </div>
        ) : (
          <div
            ref={lineRef}
            className="min-w-0 flex-1 truncate py-1 font-mono text-sm leading-6 tracking-tight text-foreground"
            title={well.copy}
          >
            {well.prompt && (
              <span className="mr-2 select-none text-muted-foreground/60">
                $
              </span>
            )}
            {well.line}
          </div>
        )}
        {canExpand && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="shrink-0 text-muted-foreground"
          >
            {expanded ? "Collapse" : "Show full"}
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-180",
              )}
            />
          </Button>
        )}
        <CopyButton value={well.copy} />
      </div>
      {expanded && well.argv && <ArgvView argv={well.argv} />}
    </div>
  );
}

/** Each argument on its own line; long ones as indented, wrapped blocks. */
function ArgvView({ argv }: { argv: string[] }) {
  const lines = groupArgv(argv);
  return (
    <div className="max-h-[28rem] overflow-auto border-t p-3 font-mono text-[13px] leading-6">
      {lines.map((line, index) => {
        const program = line.text.split(" ")[0];
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered argv
            key={index}
            className={cn(
              "flex min-w-0 gap-2",
              index > 0 && line.block && "mt-1.5",
            )}
          >
            <span
              className={cn(
                "w-3 shrink-0 select-none text-muted-foreground/60",
                index > 0 && "invisible",
              )}
            >
              $
            </span>
            {line.block ? (
              <ScriptBlock script={line.text} />
            ) : (
              <span className="min-w-0 break-all text-foreground">
                {index === 0 ? (
                  <>
                    {program}
                    <span className="text-muted-foreground">
                      {line.text.slice(program.length)}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">{line.text}</span>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A shell script, one `&&` step per line. An inline program (`node -e '…'`,
 * `python -c '…'`) is unescaped and split into statements so it reads as
 * code rather than quoting. Display only.
 */
function ScriptBlock({ script }: { script: string }) {
  const steps = script.includes("\n") ? [script] : splitShellSteps(script);
  return (
    <div className="min-w-0 flex-1 space-y-0.5 border-l-2 border-border pl-3 text-foreground/90">
      {steps.map((step, index) => {
        const inline = step.match(
          /^((?:&&|\|\|)\s+)?(\S+\s+-[ec])\s+'([\s\S]*)'\s*$/,
        );
        if (!inline) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered steps
            <div key={index} className="whitespace-pre-wrap break-words">
              <StepText text={step} />
            </div>
          );
        }
        const [, joiner = "", program, body] = inline;
        const code = body.replaceAll(`'"'"'`, "'").replaceAll(`'\\''`, "'");
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered steps
          <div key={index} className="min-w-0">
            <StepText text={`${joiner}${program}`} />
            <pre className="mt-0.5 ml-1 whitespace-pre-wrap break-words rounded-sm bg-background/60 px-3 py-2 font-mono text-[12.5px] leading-[1.6] text-foreground/80 dark:bg-white/[0.03]">
              {code
                .split(/;\s+(?=\S)/)
                .map((statement, i, all) =>
                  i < all.length - 1 ? `${statement};` : statement,
                )
                .join("\n")}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

function StepText({ text }: { text: string }) {
  const joiner = text.match(/^(&&|\|\|)\s+/);
  if (!joiner) return <>{text}</>;
  return (
    <>
      <span className="text-muted-foreground">{joiner[1]} </span>
      {text.slice(joiner[0].length)}
    </>
  );
}

function Tags({
  spec,
  showTransport,
}: {
  spec: McpServerSpec;
  showTransport: boolean;
}) {
  const tags: { key: string; icon: ReactNode; text: ReactNode }[] = [];
  if (spec.transport && showTransport) {
    tags.push({
      key: "transport",
      icon: <ArrowLeftRight />,
      text: (
        <>
          {spec.transport}
          {spec.transportDetail && (
            <span className="font-mono text-muted-foreground">
              :{spec.transportDetail}
            </span>
          )}
        </>
      ),
    });
  }
  if (spec.interactiveTools) {
    tags.push({
      key: "ui",
      icon: <MonitorSmartphone />,
      text: "Interactive UI",
    });
  }
  if (spec.skillCount) {
    tags.push({
      key: "skills",
      icon: <Sparkles />,
      text: `${spec.skillCount} ${spec.skillCount === 1 ? "skill" : "skills"}`,
    });
  }
  if (spec.serverType === "builtin") {
    tags.push({
      key: "tools",
      icon: <Boxes />,
      text: `${spec.toolCount} ${spec.toolCount === 1 ? "tool" : "tools"}`,
    });
  }
  if (tags.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <li
          key={tag.key}
          className="inline-flex h-6 items-center gap-1.5 rounded-md border bg-background px-2 text-xs text-foreground [&>svg]:size-3.5 [&>svg]:text-muted-foreground"
        >
          {tag.icon}
          {tag.text}
        </li>
      ))}
    </ul>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await copyToClipboard(value);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy");
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={onCopy}
      aria-label="Copy"
      className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

/** Shell-quote an argument only when it needs it, preferring double quotes. */
function quoteArg(arg: string) {
  if (!/[\s'"$`\\]/.test(arg)) return arg;
  if (!/["$`\\]/.test(arg)) return `"${arg}"`;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/** Short arguments share a line; a long one (a script) gets its own block. */
function groupArgv(argv: string[]) {
  const lines: { text: string; block: boolean }[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) lines.push({ text: current.join(" "), block: false });
    current = [];
  };
  for (const arg of argv) {
    if (arg.length > 48 || arg.includes("\n")) {
      flush();
      lines.push({ text: arg, block: true });
    } else {
      current.push(quoteArg(arg));
    }
  }
  flush();
  return lines;
}

/** Split a shell script at top-level `&&` / `||`, ignoring quoted text. */
function splitShellSteps(script: string) {
  const steps: string[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let i = 0; i < script.length; i++) {
    const char = script[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const joiner = script.slice(i).match(/^\s+(?=(?:&&|\|\|)\s)/);
    if (joiner && i > start) {
      steps.push(script.slice(start, i));
      start = i + joiner[0].length;
      i = start;
    }
  }
  steps.push(script.slice(start));
  return steps;
}

/** `repo@sha256:…` or `repo:tag` → the repository and its pinned reference. */
function splitImage(image: string): { repo: string; ref?: string } {
  const at = image.indexOf("@");
  if (at > 0) return { repo: image.slice(0, at), ref: image.slice(at) };
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) {
    return { repo: image.slice(0, colon), ref: image.slice(colon) };
  }
  return { repo: image };
}
