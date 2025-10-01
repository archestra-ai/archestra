"use client";

import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Tool = {
  id: string;
  name: string;
  description: string | null;
};

type ToolInvocationPolicy = {
  id: string;
  toolId: string;
  description: string;
  argumentName: string;
  operator: string;
  value: string;
  action: "allow" | "block";
  blockPrompt: string | null;
};

type TrustedDataPolicy = {
  id: string;
  toolId: string;
  description: string;
  attributePath: string;
  operator: string;
  value: string;
};

const OPERATORS = [
  { value: "equal", label: "Equal" },
  { value: "notEqual", label: "Not Equal" },
  { value: "contains", label: "Contains" },
  { value: "notContains", label: "Not Contains" },
  { value: "startsWith", label: "Starts With" },
  { value: "endsWith", label: "Ends With" },
  { value: "regex", label: "Regex" },
];

export default function SettingsPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [toolInvocationPolicies, setToolInvocationPolicies] = useState<
    ToolInvocationPolicy[]
  >([]);
  const [trustedDataPolicies, setTrustedDataPolicies] = useState<
    TrustedDataPolicy[]
  >([]);
  const [loading, setLoading] = useState(true);

  // Tool Invocation Policy Form State
  const [newToolInvocationPolicy, setNewToolInvocationPolicy] = useState({
    toolId: "",
    description: "",
    argumentName: "",
    operator: "equal",
    value: "",
    action: "block" as "allow" | "block",
    blockPrompt: "",
  });

  // Trusted Data Policy Form State
  const [newTrustedDataPolicy, setNewTrustedDataPolicy] = useState({
    toolId: "",
    description: "",
    attributePath: "",
    operator: "equal",
    value: "",
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [toolsRes, tipRes, tdpRes] = await Promise.all([
        fetch("http://localhost:9000/api/tools"),
        fetch("http://localhost:9000/api/tool-invocation-policies"),
        fetch("http://localhost:9000/api/trusted-data-policies"),
      ]);

      const [toolsData, tipData, tdpData] = await Promise.all([
        toolsRes.json(),
        tipRes.json(),
        tdpRes.json(),
      ]);

      setTools(toolsData);
      setToolInvocationPolicies(tipData);
      setTrustedDataPolicies(tdpData);
    } catch (error) {
      console.error("Failed to fetch data:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateToolInvocationPolicy = async (
    e: React.FormEvent<HTMLFormElement>,
  ) => {
    e.preventDefault();
    try {
      const response = await fetch(
        "http://localhost:9000/api/tool-invocation-policies",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...newToolInvocationPolicy,
            blockPrompt: newToolInvocationPolicy.blockPrompt || null,
          }),
        },
      );

      if (response.ok) {
        await fetchData();
        setNewToolInvocationPolicy({
          toolId: "",
          description: "",
          argumentName: "",
          operator: "equal",
          value: "",
          action: "block",
          blockPrompt: "",
        });
      }
    } catch (error) {
      console.error("Failed to create policy:", error);
    }
  };

  const handleDeleteToolInvocationPolicy = async (id: string) => {
    try {
      await fetch(`http://localhost:9000/api/tool-invocation-policies/${id}`, {
        method: "DELETE",
      });
      await fetchData();
    } catch (error) {
      console.error("Failed to delete policy:", error);
    }
  };

  const handleCreateTrustedDataPolicy = async (
    e: React.FormEvent<HTMLFormElement>,
  ) => {
    e.preventDefault();
    try {
      const response = await fetch(
        "http://localhost:9000/api/trusted-data-policies",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(newTrustedDataPolicy),
        },
      );

      if (response.ok) {
        await fetchData();
        setNewTrustedDataPolicy({
          toolId: "",
          description: "",
          attributePath: "",
          operator: "equal",
          value: "",
        });
      }
    } catch (error) {
      console.error("Failed to create policy:", error);
    }
  };

  const handleDeleteTrustedDataPolicy = async (id: string) => {
    try {
      await fetch(`http://localhost:9000/api/trusted-data-policies/${id}`, {
        method: "DELETE",
      });
      await fetchData();
    } catch (error) {
      console.error("Failed to delete policy:", error);
    }
  };

  const getToolName = (toolId: string) => {
    return tools.find((t) => t.id === toolId)?.name || "Unknown Tool";
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        Loading...
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 max-w-6xl">
      <h1 className="text-3xl font-bold mb-6">Tool Configurations</h1>

      <Tabs defaultValue="tool-invocation" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="tool-invocation">
            Tool Invocation Policies
          </TabsTrigger>
          <TabsTrigger value="trusted-data">Trusted Data Policies</TabsTrigger>
        </TabsList>

        {/* Tool Invocation Policies Tab */}
        <TabsContent value="tool-invocation" className="space-y-6">
          {/* Add New Policy Form */}
          <Card>
            <CardHeader>
              <CardTitle>Add Tool Invocation Policy</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={handleCreateToolInvocationPolicy}
                className="space-y-4"
              >
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="tip-tool">Tool</Label>
                    <Select
                      value={newToolInvocationPolicy.toolId}
                      onValueChange={(value) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          toolId: value,
                        })
                      }
                      required
                    >
                      <SelectTrigger id="tip-tool">
                        <SelectValue placeholder="Select a tool" />
                      </SelectTrigger>
                      <SelectContent>
                        {tools.map((tool) => (
                          <SelectItem key={tool.id} value={tool.id}>
                            {tool.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tip-action">Action</Label>
                    <Select
                      value={newToolInvocationPolicy.action}
                      onValueChange={(value: "allow" | "block") =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          action: value,
                        })
                      }
                      required
                    >
                      <SelectTrigger id="tip-action">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="block">Block</SelectItem>
                        <SelectItem value="allow">Allow</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tip-argument">Argument Name</Label>
                    <Input
                      id="tip-argument"
                      value={newToolInvocationPolicy.argumentName}
                      onChange={(e) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          argumentName: e.target.value,
                        })
                      }
                      placeholder="e.g., recipient, to, path"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tip-operator">Operator</Label>
                    <Select
                      value={newToolInvocationPolicy.operator}
                      onValueChange={(value) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          operator: value,
                        })
                      }
                      required
                    >
                      <SelectTrigger id="tip-operator">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OPERATORS.map((op) => (
                          <SelectItem key={op.value} value={op.value}>
                            {op.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tip-value">Value</Label>
                    <Input
                      id="tip-value"
                      value={newToolInvocationPolicy.value}
                      onChange={(e) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          value: e.target.value,
                        })
                      }
                      placeholder="e.g., hacker@hacker.com, @grafana.com"
                      required
                    />
                  </div>

                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tip-description">Description</Label>
                    <Input
                      id="tip-description"
                      value={newToolInvocationPolicy.description}
                      onChange={(e) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          description: e.target.value,
                        })
                      }
                      placeholder="Describe the policy"
                      required
                    />
                  </div>

                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tip-block-prompt">
                      Block Prompt (Optional)
                    </Label>
                    <Input
                      id="tip-block-prompt"
                      value={newToolInvocationPolicy.blockPrompt}
                      onChange={(e) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          blockPrompt: e.target.value,
                        })
                      }
                      placeholder="Custom message when blocked"
                    />
                  </div>
                </div>

                <Button type="submit" className="w-full">
                  Add Policy
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Existing Policies List */}
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Existing Policies</h2>
            {toolInvocationPolicies.length === 0 ? (
              <p className="text-muted-foreground">No policies configured</p>
            ) : (
              toolInvocationPolicies.map((policy) => (
                <Card key={policy.id}>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">
                      {getToolName(policy.toolId)}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs px-2 py-1 rounded ${
                          policy.action === "block"
                            ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                            : "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                        }`}
                      >
                        {policy.action}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          handleDeleteToolInvocationPolicy(policy.id)
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 text-sm">
                      <p className="font-medium">{policy.description}</p>
                      <div className="bg-muted p-2 rounded font-mono text-xs">
                        {policy.argumentName} {policy.operator} "{policy.value}"
                      </div>
                      {policy.blockPrompt && (
                        <p className="text-muted-foreground italic">
                          Block message: {policy.blockPrompt}
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>

        {/* Trusted Data Policies Tab */}
        <TabsContent value="trusted-data" className="space-y-6">
          {/* Add New Policy Form */}
          <Card>
            <CardHeader>
              <CardTitle>Add Trusted Data Policy</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={handleCreateTrustedDataPolicy}
                className="space-y-4"
              >
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tdp-tool">Tool</Label>
                    <Select
                      value={newTrustedDataPolicy.toolId}
                      onValueChange={(value) =>
                        setNewTrustedDataPolicy({
                          ...newTrustedDataPolicy,
                          toolId: value,
                        })
                      }
                      required
                    >
                      <SelectTrigger id="tdp-tool">
                        <SelectValue placeholder="Select a tool" />
                      </SelectTrigger>
                      <SelectContent>
                        {tools.map((tool) => (
                          <SelectItem key={tool.id} value={tool.id}>
                            {tool.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tdp-attribute">Attribute Path</Label>
                    <Input
                      id="tdp-attribute"
                      value={newTrustedDataPolicy.attributePath}
                      onChange={(e) =>
                        setNewTrustedDataPolicy({
                          ...newTrustedDataPolicy,
                          attributePath: e.target.value,
                        })
                      }
                      placeholder="e.g., emails[*].from, path"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tdp-operator">Operator</Label>
                    <Select
                      value={newTrustedDataPolicy.operator}
                      onValueChange={(value) =>
                        setNewTrustedDataPolicy({
                          ...newTrustedDataPolicy,
                          operator: value,
                        })
                      }
                      required
                    >
                      <SelectTrigger id="tdp-operator">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OPERATORS.map((op) => (
                          <SelectItem key={op.value} value={op.value}>
                            {op.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tdp-value">Value</Label>
                    <Input
                      id="tdp-value"
                      value={newTrustedDataPolicy.value}
                      onChange={(e) =>
                        setNewTrustedDataPolicy({
                          ...newTrustedDataPolicy,
                          value: e.target.value,
                        })
                      }
                      placeholder="e.g., @archestra.ai, .*/Desktop.*"
                      required
                    />
                  </div>

                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tdp-description">Description</Label>
                    <Input
                      id="tdp-description"
                      value={newTrustedDataPolicy.description}
                      onChange={(e) =>
                        setNewTrustedDataPolicy({
                          ...newTrustedDataPolicy,
                          description: e.target.value,
                        })
                      }
                      placeholder="Describe the policy"
                      required
                    />
                  </div>
                </div>

                <Button type="submit" className="w-full">
                  Add Policy
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Existing Policies List */}
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Existing Policies</h2>
            {trustedDataPolicies.length === 0 ? (
              <p className="text-muted-foreground">No policies configured</p>
            ) : (
              trustedDataPolicies.map((policy) => (
                <Card key={policy.id}>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">
                      {getToolName(policy.toolId)}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                        mark trusted
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteTrustedDataPolicy(policy.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 text-sm">
                      <p className="font-medium">{policy.description}</p>
                      <div className="bg-muted p-2 rounded font-mono text-xs">
                        {policy.attributePath} {policy.operator} "{policy.value}
                        "
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
