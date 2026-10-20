"use client";

import { BUILT_IN_AGENT_NAMES } from "@archestra/shared";
import {
  BookOpen,
  ChevronDown,
  CircleCheck,
  FileText,
  type LucideIcon,
  PencilLine,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { AppaKeeperIcon } from "@/components/appa-keeper-icon";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import { OPENAPPA_SUGGESTED_LAUNCH_PROMPTS } from "@/lib/openappa-chat-prompts";
import {
  OpenAppaChatButton,
  useOpenAppaChatLaunch,
} from "./openappa-chat-button";

type SuggestedPromptKey = keyof typeof OPENAPPA_SUGGESTED_LAUNCH_PROMPTS;

/** The agent's suggested prompts, as the chat shows them: title as the label. */
const QUESTIONS = Object.entries(OPENAPPA_SUGGESTED_LAUNCH_PROMPTS).map(
  ([promptKey, suggested]) => ({
    promptKey: promptKey as SuggestedPromptKey,
    label: suggested.summaryTitle,
  }),
);

const CHAT_LABEL = `Chat with ${BUILT_IN_AGENT_NAMES.OPENAPPA_CONFIG}`;

/**
 * Ways into the configuration agent: a plain chat that opens on the agent's
 * suggested prompts, then those same prompts, each sending itself. Wider
 * screens show the prompts as one row of chips; phones fold them into an
 * "Ask" menu beside the chat button, since wrapped chips stack unevenly.
 */
export function OpenAppaChatStrip() {
  return (
    <Card className="px-4 py-3">
      <div className="hidden flex-wrap items-center gap-2 sm:flex">
        <OpenAppaChatButton size="sm">
          <AppaKeeperIcon />
          <span>{CHAT_LABEL}</span>
        </OpenAppaChatButton>
        {QUESTIONS.map((question) => (
          <OpenAppaChatButton
            key={question.promptKey}
            size="sm"
            variant="outline"
            className="rounded-full"
            promptKey={question.promptKey}
          >
            <span>{question.label}</span>
          </OpenAppaChatButton>
        ))}
      </div>
      <div className="flex gap-2 sm:hidden">
        <OpenAppaChatButton size="sm" className="min-w-0 flex-1">
          <AppaKeeperIcon />
          <span className="truncate">{CHAT_LABEL}</span>
        </OpenAppaChatButton>
        <SuggestedPromptsMenu />
      </div>
    </Card>
  );
}

// ===

const PROMPT_ICONS: Record<SuggestedPromptKey, LucideIcon> = {
  explainGuardrails: BookOpen,
  explainPolicy: FileText,
  reviewRisks: ShieldAlert,
  changePolicy: PencilLine,
  validatePolicy: CircleCheck,
};

function SuggestedPromptsMenu() {
  // Every suggested prompt opens the same agent under the same permissions,
  // so the plain chat's launch state gates the whole menu.
  const { href, permissions } = useOpenAppaChatLaunch({
    subject: { kind: "suggestedPrompts" },
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PermissionButton
          size="sm"
          variant="outline"
          permissions={permissions}
          disabled={!href}
        >
          <span>Ask</span>
          <ChevronDown />
        </PermissionButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {QUESTIONS.map((question) => (
          <SuggestedPromptItem
            key={question.promptKey}
            promptKey={question.promptKey}
            label={question.label}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SuggestedPromptItem({
  promptKey,
  label,
}: {
  promptKey: SuggestedPromptKey;
  label: string;
}) {
  const { href } = useOpenAppaChatLaunch({
    subject: { kind: "prompt", promptKey },
  });
  const Icon = PROMPT_ICONS[promptKey];
  if (!href) {
    return (
      <DropdownMenuItem disabled>
        <Icon />
        <span>{label}</span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem asChild>
      <Link href={href}>
        <Icon />
        <span>{label}</span>
      </Link>
    </DropdownMenuItem>
  );
}
