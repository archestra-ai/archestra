"use client";

import { Editor } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentToolPatchMutation } from "@/lib/agent-tools.query";
import type { GetAllAgentToolsResponses } from "@/lib/clients/api";

interface ResponseModifierEditorProps {
  agentTool: GetAllAgentToolsResponses["200"][number];
}

export function ResponseModifierEditor({
  agentTool,
}: ResponseModifierEditorProps) {
  const agentToolPatchMutation = useAgentToolPatchMutation();

  const [template, setTemplate] = useState<string>(
    agentTool.responseModifierTemplate || "",
  );
  const [pastResponses, setPastResponses] = useState<
    Array<{ content: unknown; timestamp: Date }>
  >([]);
  const [selectedResponseIndex, setSelectedResponseIndex] = useState<number>(0);
  const [previewResult, setPreviewResult] = useState<unknown>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoadingResponses, setIsLoadingResponses] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  // Preview template whenever template or selected response changes
  const previewTemplate = useCallback(
    async (templateStr: string, content: unknown) => {
      if (!templateStr.trim()) {
        setPreviewResult(content);
        setPreviewError(null);
        return;
      }

      setIsPreviewLoading(true);
      try {
        const response = await fetch("/api/tools/preview-response-modifier", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ template: templateStr, content }),
        });

        if (response.ok) {
          const data = await response.json();
          setPreviewResult(data.result);
          setPreviewError(data.error);
        } else {
          setPreviewError("Failed to preview template");
        }
      } catch (error) {
        setPreviewError(
          error instanceof Error ? error.message : "Preview error",
        );
      } finally {
        setIsPreviewLoading(false);
      }
    },
    [],
  );

  // Load past responses when component mounts or tool changes
  useEffect(() => {
    const loadPastResponses = async () => {
      if (!agentTool.tool.mcpServerId) {
        // Only MCP tools have response modifiers
        return;
      }

      setIsLoadingResponses(true);
      try {
        const response = await fetch(
          `/api/agents/${agentTool.agent.id}/tools/${encodeURIComponent(agentTool.tool.name)}/past-responses?limit=10`,
        );

        if (response.ok) {
          const data = await response.json();
          setPastResponses(data);

          // Auto-preview with first response if template exists
          if (data.length > 0 && template) {
            previewTemplate(template, data[0].content);
          }
        }
      } catch (error) {
        console.error("Failed to load past responses:", error);
      } finally {
        setIsLoadingResponses(false);
      }
    };

    loadPastResponses();
  }, [agentTool, template, previewTemplate]);

  // Update preview when template or selected response changes
  useEffect(() => {
    if (
      pastResponses.length > 0 &&
      selectedResponseIndex < pastResponses.length
    ) {
      const debounceTimer = setTimeout(() => {
        previewTemplate(template, pastResponses[selectedResponseIndex].content);
      }, 300);

      return () => clearTimeout(debounceTimer);
    }
  }, [template, selectedResponseIndex, pastResponses, previewTemplate]);

  const handleSave = async () => {
    try {
      await agentToolPatchMutation.mutateAsync({
        id: agentTool.id,
        responseModifierTemplate: template || null,
      });
      toast.success("Response modifier template saved");
    } catch (error) {
      toast.error("Failed to save template");
      console.error("Save error:", error);
    }
  };

  const handleClear = () => {
    setTemplate("");
  };

  const hasChanges = template !== (agentTool.responseModifierTemplate || "");

  // Show message if not an MCP tool
  if (!agentTool.tool.mcpServerId) {
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

        {pastResponses.length > 0 && (
          <div className="space-y-4 pt-4 border-t">
            <div className="space-y-2">
              <Label>Preview with Past Response</Label>
              <Select
                value={String(selectedResponseIndex)}
                onValueChange={(value) =>
                  setSelectedResponseIndex(Number(value))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pastResponses.map((response, index) => (
                    <SelectItem
                      key={response.timestamp.toISOString()}
                      value={String(index)}
                    >
                      Response {index + 1} -{" "}
                      {new Date(response.timestamp).toLocaleString()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Original Response
                </Label>
                <div className="border rounded-md p-3 bg-muted/50 overflow-auto max-h-[300px]">
                  <pre className="text-xs">
                    {JSON.stringify(
                      pastResponses[selectedResponseIndex]?.content,
                      null,
                      2,
                    )}
                  </pre>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Transformed Response
                  {isPreviewLoading && (
                    <Loader2 className="inline ml-2 h-3 w-3 animate-spin" />
                  )}
                </Label>
                <div className="border rounded-md p-3 bg-muted/50 overflow-auto max-h-[300px]">
                  {previewError ? (
                    <div className="text-xs text-destructive">
                      {previewError}
                    </div>
                  ) : (
                    <pre className="text-xs">
                      {JSON.stringify(previewResult, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {isLoadingResponses && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading past responses...
          </div>
        )}

        {!isLoadingResponses && pastResponses.length === 0 && (
          <div className="text-sm text-muted-foreground py-4 border-t">
            No past tool responses found. The preview will appear once this tool
            has been executed.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
