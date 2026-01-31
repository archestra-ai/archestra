"use client";

import type { archestraApiTypes } from "@shared";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Editor } from "@/components/editor";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useProfileToolPatchMutation } from "@/lib/agent-tools.query";

interface ResponseModifierEditorProps {
  agentTool: archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number];
}

export function ResponseModifierEditor({
  agentTool: { id, responseModifierTemplate, tool },
}: ResponseModifierEditorProps) {
  const agentToolPatchMutation = useProfileToolPatchMutation();
  const [template, setTemplate] = useState<string>(
    responseModifierTemplate || "",
  );

  const handleSave = useCallback(async () => {
    await agentToolPatchMutation.mutateAsync({
      id,
      responseModifierTemplate: template || null,
    });
  }, [id, template, agentToolPatchMutation]);

  const handleClear = useCallback(() => {
    setTemplate("");
  }, []);

  const hasChanges = template !== (responseModifierTemplate || "");

  // Show message if not an MCP tool
  if (!tool.catalogId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Response Modifier</CardTitle>
          <CardDescription>
            Response modifiers are only available for MCP tools
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Response Modifier</CardTitle>
        <CardDescription>
          Use{" "}
          <Link
            href="https://handlebarsjs.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            Handlebars
          </Link>{" "}
          templates to transform tool responses before they're returned to the
          receiving MCP client. Access the response content with{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">
            {"{{response}}"}
          </code>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Template</Label>
          <div className="border rounded-md overflow-hidden">
            <Editor
              height="200px"
              defaultLanguage="handlebars"
              value={template}
              onChange={(value) => setTemplate(value || "")}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                wordWrap: "on",
                automaticLayout: true,
              }}
            />
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            onClick={handleSave}
            disabled={!hasChanges || agentToolPatchMutation.isPending}
            size="sm"
          >
            {agentToolPatchMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Template"
            )}
          </Button>
          <Button
            onClick={handleClear}
            disabled={!template}
            variant="outline"
            size="sm"
          >
            Clear
          </Button>
        </div>

        <Accordion type="single" collapsible className="mt-6">
          <AccordionItem
            value="cheat-sheet"
            className="border border-border rounded-lg bg-card !border-b"
          >
            <AccordionTrigger className="px-4 hover:no-underline">
              <span className="text-sm font-medium">
                📖 MCP Response Templating Cheat Sheet
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="space-y-4 text-sm">
                <p className="text-muted-foreground">
                  MCP tool responses follow the{" "}
                  <Link
                    href="https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-foreground"
                  >
                    MCP specification
                  </Link>
                  . Use{" "}
                  <Link
                    href="https://handlebarsjs.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-foreground"
                  >
                    Handlebars
                  </Link>{" "}
                  templates to transform responses. Access the response with{" "}
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">
                    {"{{response}}"}
                  </code>
                  .
                </p>

                <div className="space-y-6">
                  <div className="space-y-2">
                    <h4 className="font-medium">
                      Example 1: Extract text from first element
                    </h4>
                    <p className="text-muted-foreground">
                      MCP tools often return stringified JSON in a text block:
                    </p>
                    <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                      {`[
  {
    "type": "text",
    "text": "{\\"issues\\":[{\\"id\\":816,\\"title\\":\\"Add authentication\\"}]}"
  }
]`}
                    </pre>
                    <p className="text-muted-foreground mt-2">
                      Template to extract text (use triple braces to prevent
                      HTML escaping):
                    </p>
                    <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                      {'{{{lookup (lookup response 0) "text"}}}'}
                    </pre>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-medium">
                      Example 2: Parse and transform JSON
                    </h4>
                    <p className="text-muted-foreground">
                      Use nested{" "}
                      <code className="bg-muted px-1 rounded">with</code> blocks
                      with <code className="bg-muted px-1 rounded">json</code>{" "}
                      and{" "}
                      <code className="bg-muted px-1 rounded">escapeJson</code>{" "}
                      helpers:
                    </p>
                    <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                      {`{{#with (lookup response 0)}}{{#with (json this.text)}}
{
  {{#each this.issues}}
    "{{this.id}}": "{{{escapeJson this.title}}}"{{#unless @last}},{{/unless}}
  {{/each}}
}
{{/with}}{{/with}}`}
                    </pre>
                    <p className="text-muted-foreground mt-2">
                      Transforms GitHub issues to{" "}
                      <code className="bg-muted px-1 rounded">
                        {"{ id: title }"}
                      </code>{" "}
                      format
                    </p>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-medium">
                      Example 3: Return full response as-is
                    </h4>
                    <p className="text-muted-foreground">
                      Use the{" "}
                      <code className="bg-muted px-1 rounded">json</code> helper
                      to return the entire response array:
                    </p>
                    <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                      {"{{{json response}}}"}
                    </pre>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-medium">Available Helpers</h4>
                    <ul className="list-disc list-inside text-muted-foreground space-y-1">
                      <li>
                        <code className="bg-muted px-1 rounded">
                          {"{{lookup array index}}"}
                        </code>{" "}
                        - Access array element by index
                      </li>
                      <li>
                        <code className="bg-muted px-1 rounded">
                          {"{{#with expression}}"}
                        </code>{" "}
                        - Change context scope
                      </li>
                      <li>
                        <code className="bg-muted px-1 rounded">
                          {"{{json value}}"}
                        </code>{" "}
                        - Parse JSON string or stringify object
                      </li>
                      <li>
                        <code className="bg-muted px-1 rounded">
                          {"{{{escapeJson string}}}"}
                        </code>{" "}
                        - Escape quotes/special chars for JSON
                      </li>
                      <li>
                        <code className="bg-muted px-1 rounded">
                          {"{{#each array}}"}
                        </code>{" "}
                        - Iterate over arrays
                      </li>
                      <li>
                        <code className="bg-muted px-1 rounded">
                          {"{{{...}}}"}
                        </code>{" "}
                        - Triple braces prevent HTML escaping (required for
                        JSON)
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}
