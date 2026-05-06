"use client";

import { Download, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { DeploymentStatusDot } from "@/app/mcp/registry/_parts/deployment-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { envHealth } from "../_parts/utils";
import { useSpikeStore } from "../_seed/store";

export default function CrossCatalogEnvironmentsPage() {
  const { catalogItems, environments, credentials, pods } = useSpikeStore();
  const [catFilter, setCatFilter] = useState("all");
  const [visFilter, setVisFilter] = useState("all");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    return environments
      .filter((e) => catFilter === "all" || e.catalogId === catFilter)
      .filter((e) => {
        if (visFilter === "all") return true;
        if (visFilter === "org") return e.visibility.kind === "org";
        return e.visibility.kind === "team";
      })
      .filter((e) => {
        if (!search) return true;
        const q = search.toLowerCase();
        const cat = catalogItems.find((c) => c.id === e.catalogId);
        return (
          e.label.toLowerCase().includes(q) ||
          (cat?.name.toLowerCase().includes(q) ?? false)
        );
      });
  }, [environments, catFilter, visFilter, search, catalogItems]);

  const totals = useMemo(() => {
    const callers = rows.reduce(
      (acc, e) =>
        acc + credentials.filter((c) => c.environmentId === e.id).length,
      0,
    );
    const pcount = rows.reduce(
      (acc, e) => acc + pods.filter((p) => p.environmentId === e.id).length,
      0,
    );
    return { envs: rows.length, callers, pods: pcount };
  }, [rows, credentials, pods]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          All environments across every catalog item. Drilldown opens the
          catalog item scoped to the chosen environment.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm">
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
          <Button size="sm">
            <Plus className="h-4 w-4" />
            New environment
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by environment or catalog…"
              className="max-w-[260px]"
            />
            <Select value={catFilter} onValueChange={setCatFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Catalog" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All catalogs</SelectItem>
                {catalogItems.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={visFilter} onValueChange={setVisFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Visibility" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All visibilities</SelectItem>
                <SelectItem value="org">Org-wide</SelectItem>
                <SelectItem value="team">Team</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Environment</TableHead>
                <TableHead>Catalog</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead className="text-right">Callers</TableHead>
                <TableHead className="text-right">Pods</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => {
                const cat = catalogItems.find((c) => c.id === e.catalogId);
                if (!cat) return null;
                const callers = credentials.filter(
                  (c) => c.environmentId === e.id,
                ).length;
                const epods = pods.filter((p) => p.environmentId === e.id);
                const health = envHealth(epods.map((p) => p.status));
                const label =
                  epods.length === 0
                    ? "no pods"
                    : health === "running"
                      ? "up"
                      : health;
                return (
                  <TableRow key={e.id}>
                    <TableCell>
                      <Link
                        href="/mcp/registry-v2"
                        className="font-medium hover:underline"
                      >
                        {e.label}
                      </Link>
                      {e.isDefault && (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          default
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        href="/mcp/registry-v2"
                        className="text-sm hover:underline"
                      >
                        {cat.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {e.visibility.kind === "org" ? (
                        <Badge variant="secondary" className="text-[10px]">
                          org-wide
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">
                          team: {e.visibility.teamName}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {callers}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {epods.length}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5 text-xs">
                        {epods.length > 0 ? (
                          <DeploymentStatusDot state={health} />
                        ) : (
                          <span className="inline-block h-2 w-2 rounded-full bg-muted" />
                        )}
                        {label}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <div className="text-xs text-muted-foreground">
            {totals.envs} environments · {totals.callers} callers ·{" "}
            {totals.pods} pods
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
