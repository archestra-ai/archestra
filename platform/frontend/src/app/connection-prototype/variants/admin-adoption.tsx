"use client";

import { Bell, Link2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CommandBlock, ProtoPage } from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

const PEOPLE = [
  { name: "Alex Kim", agent: "Claude Code", lastUsed: "2 hours ago" },
  { name: "Priya Shah", agent: "Cursor", lastUsed: "yesterday" },
  { name: "Jordan Lee", agent: "Codex", lastUsed: "5 days ago" },
  { name: "Morgan Diaz", agent: null, lastUsed: null },
  { name: "Riley Chen", agent: null, lastUsed: null },
];

// Avenue I: what an admin sees. Funnel, who has and hasn't connected, and a
// pre-configured rollout link.
export default function AdminAdoptionVariant({
  scenario,
}: PrototypeVariantProps) {
  const { totalUsers, connectedUsers, activeThisWeek } = scenario.adoption;
  const funnel = [
    { label: "Invited", value: totalUsers },
    { label: "Visited Connect", value: Math.round(connectedUsers * 1.6) },
    { label: "Connected", value: connectedUsers },
    { label: "Active this week", value: activeThisWeek },
  ];

  return (
    <ProtoPage title="Agent adoption" width="wide">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {funnel.map((step) => (
          <div key={step.label} className="rounded-lg border bg-card p-4">
            <div className="text-2xl font-semibold">
              {step.value.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">{step.label}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2 font-medium">
          <Link2 className="size-4" />
          <span>Rollout link</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Send this to everyone. It opens Connect with your gateway, add-ons and
          recommended agent already chosen.
        </p>
        <CommandBlock code="https://archestra.example.com/connection?preset=eng-rollout" />
      </div>

      <div className="flex items-center justify-between">
        <div className="font-medium">People</div>
        <Button size="sm" variant="outline">
          <Bell />
          <span>Nudge everyone not connected</span>
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Guardrails</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {PEOPLE.map((person) => (
            <TableRow key={person.name}>
              <TableCell>{person.name}</TableCell>
              <TableCell>
                {person.agent ? (
                  <span>{person.agent}</span>
                ) : (
                  <Badge variant="outline">Not connected</Badge>
                )}
              </TableCell>
              <TableCell>{person.lastUsed ?? "—"}</TableCell>
              <TableCell>
                {person.agent ? (
                  <ShieldCheck className="size-4 text-emerald-600" />
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        Connecting gives agents tools. Enforcing what agents do with them comes
        from ArchAPPA guardrails, available on supported agents.
      </p>
    </ProtoPage>
  );
}
