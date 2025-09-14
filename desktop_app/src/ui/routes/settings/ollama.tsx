import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/ollama')({
  beforeLoad: () => {
    // Redirect to the LLM Providers -> Ollama page
    throw redirect({
      to: '/llm-providers/ollama',
    });
  },
});
