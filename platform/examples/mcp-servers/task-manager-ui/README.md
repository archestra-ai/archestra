# Task Manager UI MCP Server

Example MCP server demonstrating MCP-UI integration with interactive task management.

## Features

- Beautiful task list with priority colors
- Click to complete tasks (calls MCP tool)
- Real-time statistics
- Responsive design

## Installation

```bash
npm install
```

## Usage

Add to your Archestra MCP catalog or test directly:

```bash
npm run dev
```

## Tools

**`show_tasks`**
- Returns: Interactive task manager UI

**`complete_task`**
- Input: `{ taskId: string }`
- Returns: Confirmation message

## Demo

The UI includes:
- 4 example tasks with different priorities
- Click "Complete" button to mark done
- Automatically triggers `complete_task` tool
- Updates statistics in real-time
