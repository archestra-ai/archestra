"use client";

interface ConnectionHeroProps {
  hasMcps?: boolean;
}

export function ConnectionHero({ hasMcps = false }: ConnectionHeroProps) {
  return (
    <div>
      <h1 className="max-w-2xl text-[42px] font-extrabold leading-[1.2] tracking-tight [text-wrap:balance]">
        Give Your AI{" "}
        <span className="inline-block bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text py-1 align-baseline text-transparent">
          secure
        </span>{" "}
        access to{hasMcps ? ":" : " MCP"}
      </h1>
    </div>
  );
}
