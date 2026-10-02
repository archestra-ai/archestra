"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CommandBlock,
  INSTALL_ROUTES,
  installCommand,
  PLAN_PIECES,
  ProtoClientGrid,
  ProtoPage,
  ProtoSection,
} from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

const ROUTE_COVERAGE: Record<string, string[]> = {
  native: ["gateway"],
  script: ["gateway", "skills", "proxy", "guardrails"],
  prompt: ["gateway", "skills", "proxy", "guardrails"],
  hybrid: ["gateway", "skills", "proxy", "guardrails"],
};

// Avenue B: the four install routes side by side for the same client.
export default function RouteCompareVariant(_props: PrototypeVariantProps) {
  const [clientId, setClientId] = useState<string | null>("claude-code");

  return (
    <ProtoPage title="Connect your agent">
      <ProtoSection step={1} title="Pick your agent">
        <ProtoClientGrid selected={clientId} onSelect={setClientId} />
      </ProtoSection>
      <ProtoSection step={2} title="Choose how to install">
        {clientId ? (
          <Tabs defaultValue="native">
            <TabsList>
              {INSTALL_ROUTES.map((route) => (
                <TabsTrigger key={route.id} value={route.id}>
                  {route.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {INSTALL_ROUTES.map((route) => (
              <TabsContent
                key={route.id}
                value={route.id}
                className="flex flex-col gap-3 pt-2"
              >
                <p className="text-sm text-muted-foreground">{route.blurb}</p>
                <CommandBlock code={installCommand(route.id, clientId)} />
                <div className="flex flex-wrap gap-2 text-xs">
                  {PLAN_PIECES.map((piece) => {
                    const included = ROUTE_COVERAGE[route.id].includes(
                      piece.id,
                    );
                    return (
                      <span
                        key={piece.id}
                        className={
                          included
                            ? "rounded-full border px-2 py-0.5"
                            : "rounded-full border border-dashed px-2 py-0.5 text-muted-foreground line-through"
                        }
                      >
                        {piece.title}
                      </span>
                    );
                  })}
                </div>
              </TabsContent>
            ))}
          </Tabs>
        ) : null}
      </ProtoSection>
    </ProtoPage>
  );
}
