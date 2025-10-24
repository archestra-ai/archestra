"use client";

import { Editor } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useAgentToolPatchMutation } from "@/lib/agent-tools.query";
import type { GetAllAgentToolsResponses } from "@/lib/clients/api";

interface ResponseModifierEditorProps {
  agentTool: GetAllAgentToolsResponses["200"][number];
}

export function ResponseModifierEditor({
  agentTool: { id, responseModifierTemplate, tool },
}: ResponseModifierEditorProps) {
  const agentToolPatchMutation = useAgentToolPatchMutation();
  const [template, setTemplate] = useState<string>(
    responseModifierTemplate || "",
  );

  const handleSave = useCallback(async () => {
    try {
      await agentToolPatchMutation.mutateAsync({
        id,
        responseModifierTemplate: template || null,
      });
      toast.success("Response modifier template saved");
    } catch (error) {
      toast.error("Failed to save template");
      console.error("Save error:", error);
    }
  }, [id, template, agentToolPatchMutation]);

  const handleClear = useCallback(() => {
    setTemplate("");
  }, []);

  const hasChanges = template !== (responseModifierTemplate || "");

  // Show message if not an MCP tool
  if (!tool.mcpServerId) {
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
            className="text-primary hover:underline"
          >
            Handlebars.js
          </Link>{" "}
          templates to transform tool responses before they're sent to the LLM.
          Access the response content with{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">
            {"{{content}}"}
          </code>{" "}
          or text-only content with{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">
            {"{{text}}"}
          </code>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Template (Handlebars.js)</Label>
          <div className="border rounded-md overflow-hidden">
            <Editor
              height="200px"
              defaultLanguage="handlebars"
              value={template}
              onChange={(value) => setTemplate(value || "")}
              theme="vs-dark"
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
      </CardContent>
    </Card>
  );
}
