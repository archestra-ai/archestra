"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CommandBlock,
  installCommand,
  ListeningCard,
  PLAN_PIECES,
  ProtoClientGrid,
  ProtoPage,
  ProtoSection,
} from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

// Avenue D, the opposite bet: smallest step first, add-ons offered after the
// tools work.
export default function ToolsFirstVariant({ scenario }: PrototypeVariantProps) {
  const [clientId, setClientId] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const addOns = PLAN_PIECES.filter((piece) => piece.id !== "gateway");

  return (
    <ProtoPage
      title="Start with your tools"
      subtitle="One line adds your company's tools to your agent. Everything else is optional."
    >
      <ProtoSection step={1} title="Pick your agent">
        <ProtoClientGrid selected={clientId} onSelect={setClientId} />
      </ProtoSection>
      <ProtoSection step={2} title="Add your tools" muted={!clientId}>
        {clientId ? (
          <>
            <CommandBlock code={installCommand("native", clientId)} />
            <div>
              <Button onClick={() => setInstalled(true)}>I ran it</Button>
            </div>
          </>
        ) : null}
      </ProtoSection>
      {installed && clientId ? (
        <>
          <ListeningCard clientId={clientId} scenario={scenario} />
          <ProtoSection
            step={3}
            title="Want more?"
            description="Each add-on is separate and can be removed on its own."
          >
            <div className="grid gap-3 md:grid-cols-3">
              {addOns.map((piece) => (
                <Card key={piece.id}>
                  <CardHeader>
                    <CardTitle className="text-base">{piece.title}</CardTitle>
                    <CardDescription>{piece.summary}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2 text-xs text-muted-foreground">
                    <span>Context: {piece.context}</span>
                    <span>Undo: {piece.undo}</span>
                    <Button
                      size="sm"
                      variant={
                        added.includes(piece.id) ? "secondary" : "outline"
                      }
                      onClick={() =>
                        setAdded((prev) =>
                          prev.includes(piece.id)
                            ? prev.filter((id) => id !== piece.id)
                            : [...prev, piece.id],
                        )
                      }
                    >
                      <Plus />
                      <span>{added.includes(piece.id) ? "Added" : "Add"}</span>
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ProtoSection>
        </>
      ) : null}
    </ProtoPage>
  );
}
