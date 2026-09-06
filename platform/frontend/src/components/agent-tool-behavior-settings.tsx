import {
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import { PackageSearch, Unplug } from "lucide-react";

import { ExternalDocsLink } from "@/components/external-docs-link";
import { SettingIcon } from "@/components/setting-icon";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import {
  MISSING_CREDENTIAL_BEHAVIOR_OPTIONS,
  MISSING_CREDENTIAL_SUMMARY,
  MISSING_CREDENTIAL_TONE,
  TOOL_CONNECTION_PROMPTING,
} from "./agent-form.utils";

type MissingCredentialBehavior =
  (typeof MISSING_CREDENTIAL_BEHAVIOR_OPTIONS)[number]["value"];

interface AgentToolBehaviorSettingsProps {
  /**
   * Whether the model sees every assigned tool up front, or reaches them
   * through the search/run dispatch pair.
   */
  progressiveToolLoading: boolean;
  onProgressiveToolLoadingChange: (progressive: boolean) => void;
  /**
   * The behavior as it will actually apply — the caller resolves the stored
   * value against the mode before passing it in.
   */
  missingCredentialBehavior: MissingCredentialBehavior;
  onMissingCredentialBehaviorChange: (
    behavior: MissingCredentialBehavior,
  ) => void;
  /**
   * True in All mode, where the record reaches every tool. Both settings are
   * then decided for the user rather than by them: All mode is progressive
   * loading by definition, and `isEnforcing` in agent-credential-readiness
   * declines to enforce a missing-connection policy on an `accessAllTools`
   * record, so it always asks when a tool needs one.
   *
   * The form's only caller hides this whole block in All mode — two locked
   * controls said what the mode's own summary line already says — so today
   * this guards controls the user cannot reach. It stays because relying on
   * a parent's CSS for "not editable" is the wrong place for that rule, and
   * because a caller that does show the block gets a correct one.
   */
  locked: boolean;
  toolExposureDocsUrl: string;
  toolConnectionsDocsUrl: string;
}

/**
 * The two settings that govern how a record's tools behave at call time,
 * as opposed to which tools it has: when the model is shown them, and when a
 * user is asked for the credentials they need.
 */
export function AgentToolBehaviorSettings({
  progressiveToolLoading,
  onProgressiveToolLoadingChange,
  missingCredentialBehavior,
  onMissingCredentialBehaviorChange,
  locked,
  toolExposureDocsUrl,
  toolConnectionsDocsUrl,
}: AgentToolBehaviorSettingsProps) {
  return (
    <>
      {/* Each row reads like the detail page's: the setting's icon tinted by
          its state, and a line on what that state means. */}
      <div className="flex items-center gap-3 pb-4">
        <SettingIcon tone={progressiveToolLoading ? "on" : "off"}>
          <PackageSearch className="size-4" />
        </SettingIcon>
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label htmlFor="load-tools-when-needed">
            Progressive tool loading
          </Label>
          <FieldDescription>
            {/* Says what the setting buys before how it works: the mechanism
                was three clauses long and the reason it exists was in none
                of them. */}
            {progressiveToolLoading ? (
              <>
                Saves context by exposing only two tools:{" "}
                <code>{TOOL_SEARCH_TOOLS_SHORT_NAME}</code> and{" "}
                <code>{TOOL_RUN_TOOL_SHORT_NAME}</code>.
              </>
            ) : (
              <>
                Every assigned tool is in the model&apos;s context from the
                first message.
              </>
            )}{" "}
            <ExternalDocsLink
              href={toolExposureDocsUrl}
              className="underline"
              showIcon={false}
            >
              Learn more
            </ExternalDocsLink>
          </FieldDescription>
        </div>
        <Switch
          id="load-tools-when-needed"
          checked={progressiveToolLoading}
          disabled={locked}
          onCheckedChange={onProgressiveToolLoadingChange}
        />
      </div>

      {/* Inset past the icon column (size-8 + gap-3) so the rule divides the
          two settings rather than cutting across the icons that label them. */}
      <div className="ml-11 border-t border-border" />
      <div className="flex items-center gap-3 pt-4">
        <SettingIcon tone={MISSING_CREDENTIAL_TONE[missingCredentialBehavior]}>
          <Unplug className="size-4" />
        </SettingIcon>
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label htmlFor="missing-credential-behavior">
            Missing connections
          </Label>
          {/* Purpose first, then current status. The trigger beside this shows
              only the terse option label ("When a tool needs it"), and Radix
              keeps the menu — where each choice is spelled out — unmounted
              while the setting is merely being read, so the closed control was
              four words with no statement of what they do. The fixed summary
              says what the setting is for; the line under it states what the
              chosen option does, so the control's status is legible without
              reopening the menu, and changes as the selection changes. When All
              mode has pinned the behavior the control is disabled, so the
              second line reports the pinned effect instead of a choice the
              reader cannot make. Each branch is a <span> so machine-translate
              only ever swaps text within an element, never re-parents a bare
              node next to the link. */}
          <FieldDescription>
            <span>{MISSING_CREDENTIAL_SUMMARY} </span>
            {locked ? (
              <span>All mode always asks when a tool needs it. </span>
            ) : (
              <span>
                {TOOL_CONNECTION_PROMPTING[missingCredentialBehavior]}{" "}
              </span>
            )}
            <ExternalDocsLink
              href={toolConnectionsDocsUrl}
              className="underline"
              showIcon={false}
            >
              Learn more
            </ExternalDocsLink>
          </FieldDescription>
        </div>
        <Select
          value={missingCredentialBehavior}
          disabled={locked}
          onValueChange={(value) =>
            onMissingCredentialBehaviorChange(
              value as MissingCredentialBehavior,
            )
          }
        >
          {/* Fixed width: the trigger is `w-fit` by default, so the row would
              reflow by ~33px as the value changes. */}
          <SelectTrigger id="missing-credential-behavior" className="w-[240px]">
            <SelectValue />
          </SelectTrigger>
          {/* `popper` is what makes `align` bind at all: the default
              `item-aligned` positioning clamps only the popover's left edge,
              so it ended flush with the browser window — over 100px outside
              the wizard's panel on a wide screen. Anchored to the trigger's
              right edge it stays in the column, and 28rem keeps every
              option's explainer at two lines. */}
          <SelectContent
            position="popper"
            align="end"
            className="w-[28rem] max-w-[calc(100vw-2rem)]"
          >
            {MISSING_CREDENTIAL_BEHAVIOR_OPTIONS.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                description={TOOL_CONNECTION_PROMPTING[option.value]}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
