import * as fs from 'fs';

import { ArchestraMcpServerManifest, McpServerCategory } from '@archestra/types';

import { MCP_SERVERS_JSON_FILE_PATH } from './paths';

interface ParsedServer {
  name: string;
  githubUrl: string;
  description: string;
  category: McpServerCategory;
  languages: string[];
  deploymentScope: string[];
  operatingSystems: string[];
}

const EMOJI_MAP = {
  languages: {
    '🐍': 'Python',
    '📇': 'TypeScript',
    '🏎️': 'Go',
    '🦀': 'Rust',
    '☕': 'Java',
    '💎': 'Ruby',
    '🐘': 'PHP',
    '🔷': 'C++',
    '🟦': 'C',
    '🟨': 'JavaScript',
    '🌐': 'Web',
    '🔵': 'Kotlin',
    '🟣': 'C#',
    '🧪': 'Elixir',
    '🔺': 'Dart',
    '🟠': 'Swift',
  } as Record<string, string>,
  deployment: {
    '☁️': 'cloud',
    '🏠': 'local',
  } as Record<string, string>,
  os: {
    '🍎': 'macOS',
    '🪟': 'Windows',
    '🐧': 'Linux',
  } as Record<string, string>,
};

const CATEGORY_MAP: { [key: string]: McpServerCategory } = {
  Aggregators: 'Aggregators',
  'Art & Culture': 'Art & Culture',
  'Biology, Medicine and Bioinformatics': 'Healthcare',
  'Browser Automation': 'Browser Automation',
  'Cloud Platforms': 'Cloud',
  'Code Execution': 'Development',
  'Coding Agents': 'Development',
  'Command Line': 'CLI Tools',
  Communication: 'Communication',
  'Customer Data Platforms': 'Data',
  Databases: 'Data',
  'Data Platforms': 'Data',
  'Developer Tools': 'Development',
  Delivery: 'Logistics',
  'Data Science Tools': 'Data Science',
  'Embedded System': 'IoT',
  'File Systems': 'File Management',
  'Finance & Fintech': 'Finance',
  Gaming: 'Gaming',
  'Knowledge & Memory': 'Knowledge',
  'Location Services': 'Location',
  Marketing: 'Marketing',
  Monitoring: 'Monitoring',
  'Multimedia Process': 'Media',
  'end to end RAG platforms': 'AI Tools',
  'Search & Data Extraction': 'Search',
  Security: 'Security',
  'Social Media': 'Social Media',
  Sports: 'Sports',
  'Support & Service Management': 'Support',
  'Translation Services': 'Translation',
  'Text-to-Speech': 'Audio',
  'Travel & Transportation': 'Travel',
  'Version Control': 'Development',
  'Workplace & Productivity': 'Enterprise',
  'Other Tools and Integrations': 'Development',
};

async function fetchReadme(): Promise<string> {
  const response = await fetch('https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md');
  if (!response.ok) {
    throw new Error(`Failed to fetch README: ${response.statusText}`);
  }
  return response.text();
}

function parseServers(markdown: string): ParsedServer[] {
  const servers: ParsedServer[] = [];
  const lines = markdown.split('\n');

  let currentCategory: McpServerCategory = 'General';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check for category headers
    if (line.startsWith('###')) {
      const categoryMatch = line.match(/###\s*(.+)/);
      if (categoryMatch) {
        let rawCategory = categoryMatch[1].trim();
        // Clean up HTML anchor tags and emoji prefixes
        rawCategory = rawCategory.replace(/<a[^>]*>.*?<\/a>/g, '').trim();
        // Remove all emojis and special characters at the beginning
        rawCategory = rawCategory
          .replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]\s*/gu, '')
          .trim();
        // Remove any remaining emoji modifiers or zero-width characters
        rawCategory = rawCategory.replace(/^[\u{FE0F}\u{200D}️‍💻️️]+\s*/gu, '').trim();
        currentCategory = CATEGORY_MAP[rawCategory] || rawCategory;
      }
      continue;
    }

    // Parse server entries
    if (line.startsWith('- [')) {
      const serverMatch = line.match(/- \[([^\]]+)\]\(([^)]+)\)(.+)/);
      if (serverMatch) {
        const [_, name, url, rest] = serverMatch;

        // Extract emojis and description
        const emojiRegex = /([\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}])/gu;
        const emojis = rest.match(emojiRegex) || [];
        const description = rest.replace(emojiRegex, '').replace(/\s+/g, ' ').trim().replace(/^- /, '');

        // Parse emojis
        const languages: string[] = [];
        const deploymentScope: string[] = [];
        const operatingSystems: string[] = [];

        emojis.forEach((emoji) => {
          if (EMOJI_MAP.languages[emoji]) {
            languages.push(EMOJI_MAP.languages[emoji]);
          } else if (EMOJI_MAP.deployment[emoji]) {
            deploymentScope.push(EMOJI_MAP.deployment[emoji]);
          } else if (EMOJI_MAP.os[emoji]) {
            operatingSystems.push(EMOJI_MAP.os[emoji]);
          }
        });

        servers.push({
          name: name.trim(),
          githubUrl: url.trim(),
          description: description,
          category: currentCategory,
          languages,
          deploymentScope,
          operatingSystems,
        });
      }
    }
  }

  return servers;
}

function convertToMCPServer(parsed: ParsedServer): ArchestraMcpServerManifest {
  // Determine status based on various factors
  let status: 'stable' | 'beta' | 'experimental' = 'experimental';
  if (parsed.description.toLowerCase().includes('stable') || parsed.description.toLowerCase().includes('production')) {
    status = 'stable';
  } else if (parsed.description.toLowerCase().includes('beta')) {
    status = 'beta';
  }

  // Map features based on description keywords
  const features: string[] = [];
  const descLower = parsed.description.toLowerCase();

  if (descLower.includes('api')) features.push('API Integration');
  if (descLower.includes('database') || descLower.includes('sql')) features.push('Database Operations');
  if (descLower.includes('file') || descLower.includes('filesystem')) features.push('File Operations');
  if (descLower.includes('web') || descLower.includes('http')) features.push('Web Requests');
  if (descLower.includes('search')) features.push('Search');
  if (descLower.includes('auth')) features.push('Authentication');
  if (descLower.includes('cloud')) features.push('Cloud Integration');
  if (descLower.includes('realtime') || descLower.includes('real-time')) features.push('Real-time Updates');

  /**
   * TODO: the next time this script is run it should be updated such that it returns the correct schema😅
   */
  // return {
  //   name: parsed.name,
  //   description: parsed.description,
  //   category: parsed.category,
  //   features: features.length > 0 ? features : ['General Purpose'],
  //   status,
  //   qualityScore: null,
  //   githubUrl: parsed.githubUrl,
  //   documentation: `${parsed.githubUrl}#readme`,
  // };
  return {} as ArchestraMcpServerManifest;
}

async function main() {
  try {
    console.log('Fetching awesome-mcp-servers README...');
    const markdown = await fetchReadme();

    console.log('Parsing servers...');
    const parsedServers = parseServers(markdown);
    console.log(`Found ${parsedServers.length} servers`);

    console.log('Converting to MCPServer format...');
    const newServers = parsedServers.map(convertToMCPServer);

    // Extract only GitHub URLs
    const githubUrls = newServers.map((server) => server.github_info.url);

    // Generate JSON content
    const jsonContent = JSON.stringify(githubUrls, null, 2);

    // Write to JSON file
    fs.writeFileSync(MCP_SERVERS_JSON_FILE_PATH, jsonContent, 'utf-8');

    console.log(`Successfully updated ${MCP_SERVERS_JSON_FILE_PATH}`);
    console.log(`Total GitHub URLs: ${githubUrls.length}`);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run the parser
if (require.main === module) {
  main();
}
