"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  EmptyGatewayNotice,
  ExampleAsks,
  ProtoClientGrid,
  ProtoPage,
  ProtoSection,
  ServerLogos,
  ValueCounts,
} from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

// Avenue A: a personalized "what you get" hero before anything else.
export default function ValueHeroVariant({ scenario }: PrototypeVariantProps) {
  const [clientId, setClientId] = useState<string | null>(null);

  return (
    <ProtoPage title={`${scenario.userName}, here's what your agent gets`}>
      {scenario.servers.length === 0 ? (
        <EmptyGatewayNotice />
      ) : (
        <div className="flex flex-col gap-5 rounded-xl border bg-gradient-to-br from-primary/5 to-transparent p-6">
          <ValueCounts scenario={scenario} />
          <ServerLogos scenario={scenario} />
          {scenario.skills.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles className="size-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Your agent will also learn
              </span>
              {scenario.skills.slice(0, 4).map((skill) => (
                <Badge key={skill.id} variant="secondary">
                  {skill.name}
                </Badge>
              ))}
            </div>
          ) : null}
          <ExampleAsks scenario={scenario} />
        </div>
      )}
      <ProtoSection title="Pick your agent to get started">
        <ProtoClientGrid selected={clientId} onSelect={setClientId} />
      </ProtoSection>
    </ProtoPage>
  );
}
