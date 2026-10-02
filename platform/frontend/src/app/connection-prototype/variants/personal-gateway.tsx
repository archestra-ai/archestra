"use client";

import { Lock, Search } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProtoPage } from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

type FreedomLevel = "locked" | "curated" | "open";

const LEVEL_COPY: Record<FreedomLevel, string> = {
  locked: "Your admin picked these for everyone.",
  curated: "Pick from the tools your admin approved. Recommended ones are on.",
  open: "Pick anything you already have access to.",
};

// Avenue H: users shape a personal selection inside the box an admin sets.
// The tab row stands in for the admin's freedom-level setting.
export default function PersonalGatewayVariant({
  scenario,
}: PrototypeVariantProps) {
  const [level, setLevel] = useState<FreedomLevel>("curated");
  const [query, setQuery] = useState("");
  const [off, setOff] = useState<string[]>([]);
  const [includeFuture, setIncludeFuture] = useState(true);
  const visible = scenario.servers
    .filter((server) => server.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 12);

  return (
    <ProtoPage
      title="Choose what your agent can use"
      subtitle={LEVEL_COPY[level]}
    >
      <Tabs
        value={level}
        onValueChange={(value) => setLevel(value as FreedomLevel)}
      >
        <TabsList>
          <TabsTrigger value="locked">Admin: locked</TabsTrigger>
          <TabsTrigger value="curated">Admin: curated</TabsTrigger>
          <TabsTrigger value="open">Admin: open</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="relative">
        <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder={`Search ${scenario.servers.length.toLocaleString()} integrations`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="divide-y rounded-lg border bg-card">
        {visible.map((server, index) => (
          <div key={server.id} className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span>{server.name}</span>
                {level === "curated" && index < 3 ? (
                  <Badge variant="secondary">Recommended for your team</Badge>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {server.category} · {server.toolCount} tools
              </div>
            </div>
            {level === "locked" ? (
              <Lock className="size-4 text-muted-foreground" />
            ) : (
              <Switch
                checked={!off.includes(server.id)}
                onCheckedChange={(checked) =>
                  setOff((prev) =>
                    checked
                      ? prev.filter((id) => id !== server.id)
                      : [...prev, server.id],
                  )
                }
                aria-label={`Include ${server.name}`}
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 text-sm">
        <Switch
          id="include-future"
          checked={includeFuture}
          onCheckedChange={setIncludeFuture}
          disabled={level === "locked"}
        />
        <Label htmlFor="include-future">
          Automatically include integrations added later
        </Label>
      </div>
    </ProtoPage>
  );
}
