"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { useSpikeStore } from "../_seed/store";

type Row = {
  catalogId: string;
  catalogName: string;
  kind: "env" | "user";
  key: string;
  type: string;
  required: boolean;
  source: string;
  targets: string[];
};

export default function CrossCatalogFieldsPage() {
  const { catalogItems } = useSpikeStore();
  const [catFilter, setCatFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [search, setSearch] = useState("");

  const allRows: Row[] = useMemo(() => {
    return catalogItems.flatMap((c) =>
      c.fields.map<Row>((f) => {
        const targets = c.mappings
          .filter(
            (m) =>
              (m.source.kind === "field" && m.source.key === f.key) ||
              (m.source.kind === "template" &&
                m.source.template.includes(`{${f.kind}.${f.key}}`)),
          )
          .map(
            (m) =>
              `${m.target.kind}:${"name" in m.target ? m.target.name : m.target.path}`,
          );
        return {
          catalogId: c.id,
          catalogName: c.name,
          kind: f.kind,
          key: f.key,
          type: f.type,
          required: f.required,
          source: f.kind === "env" ? "per-environment" : (f.source ?? ""),
          targets,
        };
      }),
    );
  }, [catalogItems]);

  const rows = useMemo(() => {
    return allRows
      .filter((r) => catFilter === "all" || r.catalogId === catFilter)
      .filter((r) => kindFilter === "all" || r.kind === kindFilter)
      .filter((r) => {
        if (!search) return true;
        const q = search.toLowerCase();
        return (
          r.key.toLowerCase().includes(q) ||
          r.catalogName.toLowerCase().includes(q)
        );
      });
  }, [allRows, catFilter, kindFilter, search]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Read-only audit view of every field across every catalog item. Use to
        spot mapping conflicts and consistency issues.
      </p>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by key or catalog…"
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
            <Select value={kindFilter} onValueChange={setKindFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Kind" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                <SelectItem value="env">Environment</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Catalog</TableHead>
                <TableHead className="w-[80px]">Kind</TableHead>
                <TableHead>Field</TableHead>
                <TableHead className="w-[100px]">Type</TableHead>
                <TableHead className="w-[100px]">Required</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Mapped to</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.catalogId}-${r.kind}-${r.key}`}>
                  <TableCell>
                    <Link
                      href="/mcp/registry-v2"
                      className="text-sm hover:underline"
                    >
                      {r.catalogName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={r.kind === "env" ? "default" : "secondary"}
                      className="text-[10px] uppercase"
                    >
                      {r.kind}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.key}</TableCell>
                  <TableCell className="text-xs">{r.type}</TableCell>
                  <TableCell className="text-xs">
                    {r.required ? (
                      <Badge variant="outline" className="text-[10px]">
                        required
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">optional</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.source}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {r.targets.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        r.targets.map((t) => (
                          <Badge
                            key={t}
                            variant="outline"
                            className="font-mono text-[10px]"
                          >
                            {t}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="text-xs text-muted-foreground">
            {rows.length} fields across{" "}
            {new Set(rows.map((r) => r.catalogId)).size} catalog items
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
