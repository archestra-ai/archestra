import { openai } from '@ai-sdk/openai';
import { LanguageModelV2 } from '@ai-sdk/provider';
import {
  ToolInvocationStaticAutonomyPolicy,
  ToolResponseStaticAutonomyPolicy,
} from './security/types';

export default {
  model: openai('gpt-4o') as LanguageModelV2,
  maxToolCalls: 5,
  toolInvocationStaticAutonomyPolicies: [
    // cannot send emails to @grafana.com domain
    {
      mcpServerName: 'gmail',
      toolName: 'sendEmail',
      description: 'Cannot send emails to @grafana.com domain',
      argumentName: 'to',
      operator: 'endsWith',
      value: '@grafana.com',
      allow: false,
    },
    // block reading sensitive files
    {
      mcpServerName: 'file',
      toolName: 'readFile',
      description: 'Cannot read SSH keys',
      argumentName: 'path',
      operator: 'contains',
      value: '.ssh',
      allow: false,
    },
    {
      mcpServerName: 'file',
      toolName: 'readFile',
      description: 'Cannot read environment files',
      argumentName: 'path',
      operator: 'contains',
      value: '.env',
      allow: false,
    },
  ] as ToolInvocationStaticAutonomyPolicy[],
  toolResponseStaticAutonomyPolicies: [
    // Emails from @archestra.ai domains are safe
    {
      mcpServerName: 'gmail',
      toolName: 'getEmails',
      description: 'E-mails from @archestra.ai domains are safe',
      attributePath: 'emails[*].from',
      operator: 'endsWith',
      value: '@archestra.ai',
      trusted: true,
    },
  ] as ToolResponseStaticAutonomyPolicy[],
};
