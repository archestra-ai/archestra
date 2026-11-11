"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAvailableAutoRouters } from "@/lib/auto-routing.query";
import { useFeature } from "@/lib/config/config.query";

/**
 * Whether a virtual key or OAuth client form shows {@link AutoRoutersField}: the feature is on
 * and the caller may change which credentials reach an auto router.
 */
export function useCanSetAutoRouters(): boolean {
  const enabled = useFeature("autoRoutingEnabled") === true;
  const { data: canUpdate } = useHasPermissions({ llmProxy: ["update"] });
  return enabled && canUpdate === true;
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
