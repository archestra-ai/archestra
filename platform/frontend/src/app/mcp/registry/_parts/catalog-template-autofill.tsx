"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type UseFormReturn, useFormState, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useCatalogTemplateCandidates } from "@/lib/mcp/external-mcp-catalog.query";
import {
  deriveCatalogSearchTerm,
  findExternalCatalogMatch,
} from "./catalog-duplicate";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";

/**
 * Silent metadata enrichment for create-from-scratch: the moment the typed
 * connection identity (command line, image, or URL) strictly matches an
 * online-catalog template, the template's name, description, and logo are
 * written into the fields the user has NOT touched — no suggestion step.
 * A receipt toast with Undo is the only surface; dirty fields are never
 * overwritten, and fills are not marked dirty themselves, so a later match
 * keeps tracking until the user takes a field over.
 *
 * Renders nothing. It is a component (not a hook) so its useFormState
 * subscription — required for dirtyFields to be tracked at all — re-renders
 * only this empty node, never the whole form. Mount it only in create mode
 * with the org's online catalog enabled.
 */
export function CatalogTemplateAutofill({
  form,
}: {
  form: UseFormReturn<McpCatalogFormValues>;
}) {
  // Strong identity fields only — the name deliberately does not trigger a
  // lookup (a name coincidence must not silently write foreign metadata).
  const command = useWatch({
    control: form.control,
    name: "localConfig.command",
  });
  const argumentsText = useWatch({
    control: form.control,
    name: "localConfig.arguments",
  });
  const dockerImage = useWatch({
    control: form.control,
    name: "localConfig.dockerImage",
  });
  const serverUrl = useWatch({ control: form.control, name: "serverUrl" });
  // A subscribed read — an imperative form.formState.dirtyFields peek is
  // only populated when SOMETHING subscribes, so the pristine gate below
  // must not depend on another component happening to.
  const { dirtyFields } = useFormState({ control: form.control });

  const watched = `${command} ${argumentsText} ${dockerImage} ${serverUrl}`;
  const [matchInput, setMatchInput] = useState<McpCatalogFormValues | null>(
    null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: watched is the debounce trigger — the effect reads fresh values via form.getValues()
  useEffect(() => {
    const timeoutId = setTimeout(
      () => setMatchInput(structuredClone(form.getValues())),
      500,
    );
    return () => clearTimeout(timeoutId);
  }, [watched, form]);

  const term = useMemo(
    () => (matchInput ? deriveCatalogSearchTerm(matchInput) : null),
    [matchInput],
  );
  const { data: candidates } = useCatalogTemplateCandidates(term);
  const match = useMemo(
    () =>
      matchInput && candidates
        ? findExternalCatalogMatch(matchInput, candidates)
        : null,
    [matchInput, candidates],
  );

  // One fill (and one receipt) per template; switching to a different
  // matched template may fill again — still only into pristine fields.
  const appliedTemplateRef = useRef<string | null>(null);
  const dirtyName = Boolean(dirtyFields.name);
  const dirtyDescription = Boolean(dirtyFields.description);
  const dirtyIcon = Boolean(dirtyFields.icon);
  useEffect(() => {
    if (!match || appliedTemplateRef.current === match.manifest.name) return;
    appliedTemplateRef.current = match.manifest.name;

    const filledLabels: string[] = [];
    const undoActions: Array<() => void> = [];
    const fill = (
      path: "name" | "description",
      next: string | undefined,
      label: string,
      pristine: boolean,
    ) => {
      if (!next || !pristine || form.getValues(path) === next) return;
      const previous = form.getValues(path);
      // No shouldDirty: an auto-filled field stays pristine, so the user's
      // first own edit — not ours — is what freezes it.
      form.setValue(path, next, { shouldValidate: true });
      filledLabels.push(label);
      undoActions.push(() =>
        form.setValue(path, previous ?? "", { shouldValidate: true }),
      );
    };
    fill("name", match.manifest.display_name, "name", !dirtyName);
    fill(
      "description",
      match.manifest.description,
      "description",
      !dirtyDescription,
    );
    const icon = match.manifest.icon;
    if (icon && !dirtyIcon && form.getValues("icon") !== icon) {
      const previousIcon = form.getValues("icon");
      form.setValue("icon", icon, { shouldValidate: true });
      filledLabels.push("logo");
      undoActions.push(() =>
        form.setValue("icon", previousIcon ?? null, { shouldValidate: true }),
      );
    }
    if (filledLabels.length === 0) return;

    toast.success(
      `Matched "${match.manifest.display_name}" in the online catalog — filled ${filledLabels.join(", ")}`,
      {
        action: {
          label: "Undo",
          onClick: () => {
            for (const undo of undoActions) {
              undo();
            }
          },
        },
      },
    );
  }, [match, form, dirtyName, dirtyDescription, dirtyIcon]);

  return null;
}
