"use client";

import { useCallback, useEffect, useState } from "react";
import { type GetToolsResponse, getTools } from "shared/api-client";

export default function ToolMappingPage() {
  const [tools, setTools] = useState<GetToolsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchTools = useCallback(async () => {
    try {
      const { data } = await getTools();
      if (data) {
        setTools(data);
      } else {
        setError("Failed to fetch tools");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch tools");
    }
  }, []);

  useEffect(() => {
    fetchTools();
  }, [fetchTools]);

  if (error) {
    return <div>Error: {error}</div>;
  }

  if (tools === null) {
    return <div>Loading...</div>;
  }

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Tool Mapping</h1>
      {tools.length === 0 ? (
        <p>No tools found</p>
      ) : (
        <div className="space-y-4">
          {tools.map((tool) => (
            <pre
              key={tool.id}
              className="bg-gray-100 p-4 rounded overflow-auto"
            >
              {JSON.stringify(tool, null, 2)}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}
