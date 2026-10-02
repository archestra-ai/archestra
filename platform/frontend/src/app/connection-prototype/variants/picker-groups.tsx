"use client";

import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CommandBlock,
  GUARDRAIL_CLIENT_IDS,
  MOCK_GATEWAY_URL,
  ProtoClientGrid,
  ProtoPage,
} from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

const OTHER_HARNESSES = [
  "VS Code",
  "Windsurf",
  "Gemini CLI",
  "Zed",
  "Cline",
  "Goose",
  "OpenClaw",
  "Hermes",
  "Grok",
];

// Avenue C: three groups split by guardrail support, as tabs.
export default function PickerGroupsVariant(_props: PrototypeVariantProps) {
  const [clientId, setClientId] = useState<string | null>(null);

  return (
    <ProtoPage
      title="Which agent do you use?"
      subtitle="Every agent gets the same tools. Supported agents also get your company's guardrails."
    >
      <Tabs defaultValue="supported">
        <TabsList>
          <TabsTrigger value="supported">
            <ShieldCheck />
            <span>Supported</span>
          </TabsTrigger>
          <TabsTrigger value="other">Other agents</TabsTrigger>
          <TabsTrigger value="n8n">Workflows (n8n)</TabsTrigger>
        </TabsList>
        <TabsContent value="supported" className="flex flex-col gap-3 pt-2">
          <p className="text-sm text-muted-foreground">
            Full one-step install: tools, skills, model routing and guardrails.
          </p>
          <ProtoClientGrid
            selected={clientId}
            onSelect={setClientId}
            clientIds={GUARDRAIL_CLIENT_IDS}
          />
        </TabsContent>
        <TabsContent value="other" className="flex flex-col gap-3 pt-2">
          <p className="text-sm text-muted-foreground">
            Any agent that supports remote MCP. You get the tools (and skills
            where your agent supports them). Guardrails aren't available yet.
          </p>
          <div className="flex flex-wrap gap-2">
            {OTHER_HARNESSES.map((name) => (
              <span
                key={name}
                className="rounded-full border px-3 py-1 text-sm"
              >
                {name}
              </span>
            ))}
            <span className="rounded-full border border-dashed px-3 py-1 text-sm text-muted-foreground">
              Anything else
            </span>
          </div>
          <CommandBlock code={MOCK_GATEWAY_URL} />
        </TabsContent>
        <TabsContent value="n8n" className="flex flex-col gap-3 pt-2">
          <p className="text-sm text-muted-foreground">
            n8n uses your tools from a workflow node instead of a chat. Add an
            MCP Client node with this URL and an API key.
          </p>
          <ProtoClientGrid
            selected="n8n"
            onSelect={() => {}}
            clientIds={["n8n"]}
          />
          <CommandBlock code={MOCK_GATEWAY_URL} />
        </TabsContent>
      </Tabs>
    </ProtoPage>
  );
}
