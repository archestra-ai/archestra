import { useEffect, useState } from "react";

interface McpAppResourceResult {
  html: string | null;
  loading: boolean;
  error: string | null;
}

export function useMcpAppResource(
  resourceUri: string | null,
): McpAppResourceResult {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!resourceUri) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setHtml(null);

    fetch("/api/mcp/resources/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: resourceUri }),
    })
      .then((res) => {
        if (!res.ok)
          throw new Error(`Failed to fetch resource: ${res.statusText}`);
        return res.json();
      })
      .then((data: { html: string }) => {
        if (!cancelled) setHtml(data.html);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [resourceUri]);

  return { html, loading, error };
}
