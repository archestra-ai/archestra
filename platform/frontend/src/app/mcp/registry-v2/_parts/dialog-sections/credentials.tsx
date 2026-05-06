"use client";

import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { useSpikeStore } from "../../_seed/store";
import type { CatalogItem } from "../../_seed/types";
import { InstallDialog } from "../install-dialog";
import { fmtDate } from "../utils";

export function CredentialsSection({ cat }: { cat: CatalogItem }) {
  const { environments, credentials, revokeCredential, currentUser } =
    useSpikeStore();
  const envs = environments.filter((e) => e.catalogId === cat.id);
  const [filter, setFilter] = useState<string>("all");

  const groups = useMemo(() => {
    return envs
      .filter((e) => filter === "all" || e.id === filter)
      .map((env) => ({
        env,
        rows: credentials.filter((c) => c.environmentId === env.id),
      }));
  }, [envs, credentials, filter]);

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Per-(environment, caller) credential rows.
        </p>
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Environment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All environments</SelectItem>
              {envs.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <InstallDialog cat={cat} />
        </div>
      </div>

      <div className="space-y-4">
        {groups.map(({ env, rows }) => (
          <Card key={env.id}>
            <CardContent className="p-0">
              <div className="border-b px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{env.label}</span>
                    {env.visibility.kind === "org" ? (
                      <Badge variant="secondary" className="text-[10px]">
                        org-wide
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        team: {env.visibility.teamName}
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {rows.length} {rows.length === 1 ? "caller" : "callers"}
                  </span>
                </div>
              </div>
              {rows.length === 0 ? (
                <div className="px-4 py-3 text-xs text-muted-foreground">
                  No credentials yet.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Owner</TableHead>
                      <TableHead>Pod</TableHead>
                      <TableHead className="w-[120px]">Storage</TableHead>
                      <TableHead className="w-[160px]">Created</TableHead>
                      <TableHead className="w-[100px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="text-sm">{c.ownerEmail}</span>
                            {c.ownerId === currentUser.id && (
                              <Badge variant="outline" className="text-[9px]">
                                You
                              </Badge>
                            )}
                            <Badge variant="secondary" className="text-[9px]">
                              {c.scope}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 font-mono text-xs">
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            <span className="truncate">{c.podId}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {c.secretStorage}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmtDate(c.createdAt)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => revokeCredential(c.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
