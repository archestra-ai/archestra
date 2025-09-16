import { Brain, type LucideIcon } from 'lucide-react';

export interface PromptTemplate {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  category: string;
  prompt: string;
}

export const promptTemplates: PromptTemplate[] = [
  {
    id: 'initial-setup',
    title: 'Personal Assistant Setup',
    description: 'Help me get to know you better to provide personalized assistance',
    icon: Brain,
    category: 'Setup',
    prompt: `I'd like to set up my personal AI assistant. Please, read memories first and ask me a series of questions if memories don't have such a data:

1. My name.
2. My current role in the company
3. My email
4. My current project name and short description

Please ask these questions one by one, and save in memory.

Once you're done with questions, suggest me to go to "MCP Connectors" settings page to connect to my data sources (e.g. Google Drive, Notion, etc.) and enable relevant tools.
`,
  },
];
