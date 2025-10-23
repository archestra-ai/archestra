"use client";

import { Button } from "../ui/button";
import CopyButton from "../ui/copy-button";
import { PROVIDER_INFO } from "./constants";

export default function ProviderDetails({
  provider,
  proxyUrl,
  onProxyChange,
}: {
  provider: "openai" | "anthropic";
  proxyUrl: string;
  onProxyChange: (v: string) => void;
}) {
  const info = PROVIDER_INFO[provider];

  return (
    <div className="space-y-4">
      <div>
        <p className="block text-sm text-slate-300">API Base URL</p>
        <div className="mt-2 flex gap-2">
          <input
            readOnly
            value={info.baseUrl}
            className="flex-1 rounded border border-slate-700 bg-slate-950/20 px-3 py-2 text-sm text-slate-200"
          />
          <CopyButton text={info.baseUrl} />
        </div>
      </div>

      <div>
        <p className="block text-sm text-slate-300">SDK initialization</p>
        <pre className="mt-2 overflow-auto rounded bg-black/60 p-3 text-sm text-slate-100">
          {PROVIDER_INFO[provider].snippet}
        </pre>
        <div className="mt-2 flex gap-2">
          <CopyButton text={PROVIDER_INFO[provider].snippet} />
          <Button
            onClick={() =>
              window.open(info.docs, "_blank", "noopener,noreferrer")
            }
            className="rounded border px-3 py-1 text-sm text-slate-200"
          >
            Open provider docs
          </Button>
        </div>
      </div>

      <div>
        <p className="block text-sm text-slate-300">Proxy URL (agent)</p>
        <div className="mt-2 flex gap-2">
          <input
            value={proxyUrl}
            onChange={(e) => onProxyChange(e.target.value)}
            className="flex-1 rounded border border-slate-700 bg-slate-950/20 px-3 py-2 text-sm text-slate-200"
          />
          <CopyButton text={proxyUrl} />
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Use this URL in your agent as the Archestra proxy endpoint.
        </p>
      </div>
    </div>
  );
}
