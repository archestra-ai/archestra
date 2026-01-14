import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createUIResource } from '@mcp-ui/server';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Mock task data
const tasks = [
    { id: '1', title: 'Review PR #1301', status: 'pending', priority: 'high' },
    { id: '2', title: 'Update documentation', status: 'pending', priority: 'medium' },
    { id: '3', title: 'Test MCP Gateway', status: 'pending', priority: 'high' },
    { id: '4', title: 'Deploy to production', status: ' pending', priority: 'low' },
];

const server = new Server(
    {
        name: 'task-manager-ui-server',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'show_tasks',
                description: 'Show interactive task list with ability to mark tasks complete',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'complete_task',
                description: 'Mark a task as complete',
                inputSchema: {
                    type: 'object',
                    properties: {
                        taskId: {
                            type: 'string',
                            description: 'ID of the task to complete',
                        },
                    },
                    required: ['taskId'],
                },
            },
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'show_tasks') {
        // Create beautiful HTML UI for task list
        const uiResource = createUIResource({
            uri: 'ui://tasks/list',
            content: {
                type: 'rawHtml',
                htmlString: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: linear-gradient(135deg, #2193b0 0%, #6dd5ed 100%);
    }
    .task-container {
      max-width: 600px;
      background: white;
      border-radius: 20px;
      padding: 30px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    h1 {
      margin: 0 0 20px 0;
      color: #2193b0;
      font-size: 2em;
    }
    .task-item {
      display: flex;
      align-items: center;
      padding: 15px;
      margin: 10px 0;
      background: #f8f9fa;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.3s ease;
      border-left: 4px solid transparent;
    }
    .task-item:hover {
      background: #e9ecef;
      transform: translateX(5px);
    }
    .task-item.high {
      border-left-color: #dc3545;
    }
    .task-item.medium {
      border-left-color: #ffc107;
    }
    .task-item.low {
      border-left-color: #28a745;
    }
    .task-item.completed {
      opacity: 0.5;
      text-decoration: line-through;
    }
    .task-content {
      flex: 1;
    }
    .task-title {
      font-weight: 600;
      font-size: 1.1em;
      margin-bottom: 5px;
    }
    .task-priority {
      font-size: 0.85em;
      color: #6c757d;
      text-transform: uppercase;
    }
    .complete-btn {
      padding: 8px 16px;
      background: #2193b0;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.3s ease;
    }
    .complete-btn:hover {
      background: #1a7691;
      transform: scale(1.05);
    }
    .stats {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 2px solid #e9ecef;
      display: flex;
      justify-content: space-around;
    }
    .stat {
      text-align: center;
    }
    .stat-number {
      font-size: 2em;
      font-weight: bold;
      color: #2193b0;
    }
    .stat-label {
      font-size: 0.9em;
      color: #6c757d;
    }
  </style>
</head>
<body>
  <div class="task-container">
    <h1>📋 Task Manager</h1>
    
    ${tasks.map(task => `
      <div class="task-item ${task.priority} ${task.status}" id="task-${task.id}">
        <div class="task-content">
          <div class="task-title">${task.title}</div>
          <div class="task-priority">Priority: ${task.priority}</div>
        </div>
        ${task.status === 'pending' ? `
          <button class="complete-btn" onclick="completeTask('${task.id}', '${task.title}')">
            ✓ Complete
          </button>
        ` : '<span style="color: #28a745; font-weight: bold">✓ Done</span>'}
      </div>
    `).join('')}
    
    <div class="stats">
      <div class="stat">
        <div class="stat-number">${tasks.length}</div>
        <div class="stat-label">Total Tasks</div>
      </div>
      <div class="stat">
        <div class="stat-number">${tasks.filter(t => t.status === 'pending').length}</div>
        <div class="stat-label">Pending</div>
      </div>
      <div class="stat">
        <div class="stat-number">${tasks.filter(t => t.priority === 'high').length}</div>
        <div class="stat-label">High Priority</div>
      </div>
    </div>
  </div>
  
  <script>
    function completeTask(taskId, title) {
      // Mark task as completed in UI
      const taskElement = document.getElementById('task-' + taskId);
      taskElement.classList.add('completed');
      taskElement.querySelector('.complete-btn').remove();
      const doneSpan = document.createElement('span');
      doneSpan.style.color = '#28a745';
      doneSpan.style.fontWeight = 'bold';
      doneSpan.textContent = '✓ Done';
      taskElement.appendChild(doneSpan);
      
      // Send tool call to backend
      window.parent.postMessage({
        type: 'tool',
        payload: {
          toolName: 'complete_task',
          params: { taskId: taskId }
        }
      }, '*');
    }
  </script>
</body>
</html>
        `,
            },
            encoding: 'text',
        });

        return {
            content: [
                {
                    type: 'text',
                    text: `Showing ${tasks.length} tasks (${tasks.filter(t => t.status === 'pending').length} pending)`,
                },
                uiResource,
            ],
        };
    }

    if (name === 'complete_task') {
        const taskId = (args as { taskId: string }).taskId;
        const task = tasks.find(t => t.id === taskId);

        if (task) {
            task.status = 'completed';
            return {
                content: [
                    {
                        type: 'text',
                        text: `✅ Task "${task.title}" marked as complete!`,
                    },
                ],
            };
        }

        return {
            content: [
                {
                    type: 'text',
                    text: `Task ${taskId} not found`,
                },
            ],
        };
    }

    throw new Error(`Unknown tool: ${name}`);
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Task Manager UI MCP server running on stdio');
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
