"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { findCatalogDuplicate } from "./catalog-duplicate";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";

/**
 * Create-mode duplicate guard: as soon as the form carries attributable data
 * (a name, a URL, a command line, an image — typed or imported), it is
 * checked against the org's registry. A match means the user is probably
 * recreating an existing server, so the offer is to open that server's
 * editor instead — never to keep both.
 *
 * Placement contract: the form passes this node to the page through the
 * footer render prop, and the page docks it inside its sticky footer — the
 * one region that is on screen regardless of scroll position or focus, and
 * the commit point the warning is really about. It must NOT be rendered as
 * an in-flow form row: a match can fire while the matching field is scrolled
 * far out of view.
 */
export function RegistryDuplicateNotice({
  form,
}: {
  form: UseFormReturn<McpCatalogFormValues>;
}) {
  const { data: catalogItems } = useInternalMcpCatalog();

  const name = useWatch({ control: form.control, name: "name" });
  const serverUrl = useWatch({ control: form.control, name: "serverUrl" });
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

  const watched = `${name} ${serverUrl} ${command} ${argumentsText} ${dockerImage}`;
  const [matchInput, setMatchInput] = useState<McpCatalogFormValues | null>(
    null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: watched is the debounce trigger — the effect reads fresh values via form.getValues()
  useEffect(() => {
    const timeoutId = setTimeout(
      () => setMatchInput(structuredClone(form.getValues())),
      400,
    );
    return () => clearTimeout(timeoutId);
  }, [watched, form]);

  const match = useMemo(
    () => (matchInput ? findCatalogDuplicate(matchInput, catalogItems) : null),
    [matchInput, catalogItems],
  );
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  if (!match || dismissedIds.has(match.item.id)) {
    return null;
  }

  const dismissMatch = () => {
    setDismissedIds(new Set([...dismissedIds, match.item.id]));
  };

  return (
    // <output> has an implicit status role: the warning appears
    // asynchronously (debounced detection) in a fixed region — announce it
    // without stealing focus. Styled on the house subtle-amber idiom (same
    // as the Import & export block's warnings): rounded inset card, not a
    // full-bleed strip.
    <output className="mx-6 mt-4 flex items-center justify-between gap-3 rounded-md border border-amber-500/50 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <span className="font-semibold">{match.item.name}</span> is already in
          your registry ({match.reason}) — you may be recreating it.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button type="button" size="sm" variant="outline" asChild>
          <Link href={`/mcp/registry/${match.item.id}/edit`}>
            <span>Show existing server</span>
          </Link>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="hover:bg-amber-100 dark:hover:bg-amber-950/40"
          onClick={dismissMatch}
        >
          Dismiss
        </Button>
      </div>
    </output>
  );
}
