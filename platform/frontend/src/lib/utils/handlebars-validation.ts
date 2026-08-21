import { findUnparseableExpressions } from "@archestra/shared";
import { useEffect, useState } from "react";

/**
 * The template expressions in a prompt that Handlebars cannot parse.
 *
 * These are not rejected — a prompt is prose, and an expression the engine
 * cannot read is rendered as the literal text the author typed. But that is
 * almost never what someone typing `{{user.name}}` intends, and until the
 * prompt is run against a model there is nothing to notice it by, so the editor
 * says so up front.
 *
 * Handlebars is loaded lazily: only prompt authors need the parser, and it is
 * far too large to sit in the initial bundle.
 */
export function useUnparseableExpressions(template: string): string[] {
  const [expressions, setExpressions] = useState<string[]>([]);

  useEffect(() => {
    if (!template.includes("{{")) {
      setExpressions([]);
      return;
    }

    let active = true;
    void (async () => {
      try {
        const parse = await loadHandlebarsParser();
        if (!active) return;
        setExpressions(findUnparseableExpressions(template, parse));
      } catch {
        // Validation is advisory; a parser that will not load must not take
        // the editor with it.
        if (active) setExpressions([]);
      }
    })();

    return () => {
      active = false;
    };
  }, [template]);

  return expressions;
}

// ===
// Internal helpers
// ===

type HandlebarsRuntime = typeof import("handlebars");

async function loadHandlebarsParser(): Promise<(template: string) => unknown> {
  const module = await import("handlebars/dist/handlebars");
  const handlebars = (module.default ?? module) as HandlebarsRuntime;
  return (template: string) => handlebars.parse(template);
}
