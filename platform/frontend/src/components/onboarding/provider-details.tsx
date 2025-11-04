"use client";

import { FRAMEWORK_DOCS, type Framework } from "@shared";
import { useEffect, useState } from "react";
import { PROVIDER_INFO, type Provider } from "@/lib/constant";
import CopyButton from "../copy-button";
import OptionButton from "../option-button";
import { Input } from "../ui/input";

export default function ProviderDetails({
  framework,
  agentId,
}: {
  framework: Framework;
  agentId?: string | null;
}) {
  const [provider, setProvider] = useState<Provider>(
    Object.keys(PROVIDER_INFO)[0] as Provider,
  );

  const getProxyUrlWithAgent = (baseUrl: string) => {
    return agentId ? `${baseUrl}/${agentId}` : baseUrl;
  };

  const [proxyUrl, setProxyUrl] = useState(
    getProxyUrlWithAgent(PROVIDER_INFO[provider].baseUrl),
  );

  useEffect(() => {
    setProxyUrl(getProxyUrlWithAgent(PROVIDER_INFO[provider].baseUrl));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, agentId]);
  return (
    <div className="space-y-4">
      <div className="mb-4">
        <div className="block text-sm text-slate-300 mb-2">Provider</div>
        <div className="flex gap-3">
          <OptionButton
            active={provider === "openai"}
            onClick={() => setProvider("openai")}
          >
            OpenAI
          </OptionButton>
          <OptionButton
            active={provider === "anthropic"}
            onClick={() => setProvider("anthropic")}
          >
            Anthropic
          </OptionButton>
        </div>
      </div>
      <div>
        <p className="block text-sm text-slate-300">Proxy URL</p>
        <div className="mt-2 flex gap-2">
          <Input
            value={proxyUrl}
            className="flex-1 rounded border border-slate-700 bg-slate-950/20 px-3 py-2 text-sm text-slate-200"
          />
          <CopyButton text={proxyUrl} />
        </div>
        {framework && (
          <a
            href={FRAMEWORK_DOCS[framework]}
            className="text-sm text-blue-500 hover:underline"
          >
            Learn where to set it up
          </a>
        )}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="block text-sm text-slate-300">Code Snippet</div>
            <CopyButton
              text={
                agentId
                  ? PROVIDER_INFO[provider].snippet.replace(
                      PROVIDER_INFO[provider].baseUrl,
                      getProxyUrlWithAgent(PROVIDER_INFO[provider].baseUrl),
                    )
                  : PROVIDER_INFO[provider].snippet
              }
            />
          </div>
          <pre className="rounded bg-slate-950 border border-slate-700 p-4 text-xs text-slate-200 overflow-x-auto">
            <code>
              {agentId
                ? PROVIDER_INFO[provider].snippet.replace(
                    PROVIDER_INFO[provider].baseUrl,
                    getProxyUrlWithAgent(PROVIDER_INFO[provider].baseUrl),
                  )
                : PROVIDER_INFO[provider].snippet}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
}
