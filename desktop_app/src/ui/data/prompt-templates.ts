import { Brain, Briefcase, Inbox, type LucideIcon, Mail } from 'lucide-react';

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

Once you're done with questions, query my emails to get my tone of voice. If no email MCP is installed, search for emails MCP's and propose to install one.
`,
  },
  {
    id: 'linkedin-cleaner',
    title: 'LinkedIn Inbox Cleaner',
    description: 'Organize and clean up your LinkedIn messages and connections',
    icon: Briefcase,
    category: 'Social Media',
    prompt: `Help me clean and organize my LinkedIn inbox. I need assistance with:

1. Identifying and categorizing different types of messages (recruiters, sales pitches, genuine connections, spam)
2. Creating template responses for common message types
3. Identifying important messages that need immediate attention
4. Suggesting which connections might be valuable to nurture
5. Flagging messages that can be archived or deleted
6. Creating a system to keep my LinkedIn inbox organized going forward

Please provide a structured approach to tackle my LinkedIn inbox efficiently.`,
  },
  {
    id: 'email-archiver',
    title: 'Email Archiver & Cleaner',
    description: 'Organize, archive, and clean up your email inbox efficiently',
    icon: Inbox,
    category: 'Productivity',
    prompt: `I need help organizing and cleaning my email inbox. Please help me:

1. Create a categorization system for different types of emails
2. Identify emails that can be safely archived or deleted
3. Set up rules or filters for automatic organization
4. Find and unsubscribe from unwanted newsletters
5. Identify important emails that need responses
6. Create a "zero inbox" strategy that works for my workflow
7. Suggest email management best practices

Let's start by understanding what types of emails I typically receive and what my main email challenges are.`,
  },
  {
    id: 'corp-communication',
    title: 'Corporate Communication Summarizer',
    description: 'Summarize and extract key points from corporate communications',
    icon: Mail,
    category: 'Business',
    prompt: `I need help summarizing corporate communications. Please help me:

1. Extract key action items from long email threads
2. Summarize meeting notes and identify decisions made
3. Create executive summaries of lengthy reports
4. Identify important announcements from company-wide emails
5. Track project updates across multiple communication channels
6. Create weekly digests of important communications
7. Flag items that require my immediate attention or response

To start, I can share a recent corporate communication that needs summarizing, or we can discuss what types of communications you'd like me to help with regularly.`,
  },
];
