"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type AutoRouter,
  useAutoRouters,
  useAvailableAutoRouters,
} from "@/lib/auto-routing.query";

/**
 * Whether a virtual key or OAuth client form shows {@link AutoRoutersField}:
 * the caller may change which credentials reach an auto router.
 */
export function useCanSetAutoRouters(): boolean {
  const { data: canUpdate } = useHasPermissions({ llmProxy: ["update"] });
  return canUpdate === true;
}

/**
 * The auto routers added to a virtual key or OAuth client by name, each
 * removable, and a picker for the rest. A router answers with its own tiers'
 * keys, so any router can be added whatever providers the credential maps.
 */
export function AutoRoutersField({
  value,
  onChange,
}: {
  /** Routers added, by id. */
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const id = useId();
  const { data: routers = [] } = useAvailableAutoRouters();
  const listed = routers.filter((router) => value.includes(router.id));
  const addable = routers.filter((router) => !value.includes(router.id));
  const listedIds = listed.map((router) => router.id);
  const { data: details = [] } = useAutoRouters();
  const notRouting = new Map(
    details.flatMap((router) => {
      const note = notRoutingNote(router);
      return note ? [[router.id, note] as const] : [];
    }),
  );

  return (
    <div className="space-y-2">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <Label htmlFor={id}>Auto routers</Label>
        <Button variant="link" size="xs" className="h-auto px-0" asChild>
          <Link href="/llm/auto-routing">Manage auto routers</Link>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        A model name that sends each session to a fast, normal or smart model
        within a daily budget. Requests ask for a router by its name and run on
        the router&apos;s own provider keys.
      </p>
      {listed.length > 0 && (
        <div className="divide-y rounded-md border">
          {listed.map((router) => (
            <div
              key={router.id}
              className="flex items-center gap-2 px-3 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {router.name}
              </span>
              {notRouting.has(router.id) && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {notRouting.get(router.id)}
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${router.name}`}
                onClick={() =>
                  onChange(
                    listedIds.filter((routerId) => routerId !== router.id),
                  )
                }
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}
      <SearchableSelect
        id={id}
        ariaLabel="Add an auto router"
        value=""
        onValueChange={(routerId) => onChange([...listedIds, routerId])}
        placeholder="Add an auto router…"
        searchPlaceholder="Search auto routers..."
        emptyMessage={
          routers.length === 0 ? "No auto routers yet." : "No other routers."
        }
        items={addable.map((router) => ({
          value: router.id,
          label: router.name,
          content: <span className="font-mono text-sm">{router.name}</span>,
        }))}
        className="w-full"
      />
    </div>
  );
}

function notRoutingNote(router: AutoRouter): string | null {
  if (!router.enabled) return "Auto routing is off";
  if (Object.values(router.tiers).some((tier) => tier === null))
    return "Tiers not set";
  return null;
}
