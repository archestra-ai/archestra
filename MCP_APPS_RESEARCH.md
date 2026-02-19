# Archestra MCP Apps 集成研究文档

## 研究日期
2026-02-20

## 1. MCP Apps 协议概述

### 1.1 什么是 MCP Apps

MCP Apps 是 Model Context Protocol 的扩展，允许 MCP 服务器返回交互式 HTML 界面，直接在聊天宿主中渲染。

**核心优势：**
- **上下文保留**: 应用存在于对话中，用户无需切换标签页
- **双向数据流**: 应用可以调用 MCP 服务器上的任何工具，宿主可以向应用推送新结果
- **与宿主能力集成**: 应用可以委托操作给宿主，宿主通过用户已连接的能力路由请求
- **安全保证**: MCP Apps 在宿主控制的沙盒 iframe 中运行，无法访问父页面

### 1.2 MCP Apps 工作原理

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   LLM       │────▶│  MCP Host   │────▶│ MCP Server  │
│             │     │ (Archestra) │     │             │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────▼──────┐
                    │  Sandbox    │
                    │  iframe     │
                    │  (MCP App)  │
                    └─────────────┘
```

**流程：**
1. **UI 预加载**: 工具描述包含 `_meta.ui.resourceUri` 字段指向 `ui://` 资源
2. **资源获取**: 宿主从服务器获取 UI 资源（HTML 页面，通常包含 JavaScript 和 CSS）
3. **沙盒渲染**: Web 宿主在对话中的沙盒 iframe 内渲染 HTML
4. **双向通信**: 应用和宿主通过 JSON-RPC 协议通信

### 1.3 核心技术规范

**工具声明 UI 资源：**
```typescript
{
  description: 'Show widget',
  inputSchema: { query: z.string() },
  _meta: { 
    ui: { 
      resourceUri: 'ui://my-server/widget'  // 链接工具 → UI
    } 
  }
}
```

**UI 资源格式：**
```typescript
interface UIResource {
  type: 'resource';
  resource: {
    uri: string;           // 例如: ui://component/id
    mimeType: 'text/html' | 'text/uri-list' | 'application/vnd.mcp-ui.remote-dom';
    text?: string;         // 内联 HTML、外部 URL 或 remote-dom 脚本
    blob?: string;         // Base64 编码内容
  };
}
```

**支持的 MIME 类型：**
- `text/html;profile=mcp-app` - MCP Apps 标准
- `text/uri-list` - 外部 URL
- `application/vnd.mcp-ui.remote-dom` - Remote DOM 脚本

### 1.4 权限和内容安全策略

```typescript
_meta: {
  ui: {
    resourceUri: 'ui://my-server/widget',
    permissions: ['microphone', 'camera'],  // 请求额外权限
    csp: {
      // 控制应用可以加载资源的外部来源
      'connect-src': ['https://api.example.com']
    }
  }
}
```

## 2. mcp-ui SDK 分析

### 2.1 服务端 SDK (@mcp-ui/server)

**创建 UI 资源：**
```typescript
import { createUIResource } from '@mcp-ui/server';

const widgetUI = createUIResource({
  uri: 'ui://my-server/widget',
  content: { 
    type: 'rawHtml', 
    htmlString: '<h1>Widget</h1>' 
  },
  encoding: 'text',
});
```

**注册 App 工具：**
```typescript
import { registerAppTool, registerAppResource } from '@modelcontextprotocol/ext-apps/server';

// 1. 注册资源处理器
registerAppResource(server, 'widget_ui', widgetUI.resource.uri, {}, async () => ({
  contents: [widgetUI.resource]
}));

// 2. 注册带 UI 链接的工具
registerAppTool(server, 'show_widget', {
  description: 'Show widget',
  inputSchema: { query: z.string() },
  _meta: { ui: { resourceUri: widgetUI.resource.uri } }
}, async ({ query }) => {
  return { content: [{ type: 'text', text: `Query: ${query}` }] };
});
```

### 2.2 客户端 SDK (@mcp-ui/client)

**AppRenderer (MCP Apps 推荐)：**
```typescript
import { AppRenderer } from '@mcp-ui/client';

function ToolUI({ client, toolName, toolInput, toolResult }) {
  return (
    <AppRenderer
      client={client}
      toolName={toolName}
      sandbox={{ url: sandboxUrl }}
      toolInput={toolInput}
      toolResult={toolResult}
      onOpenLink={async ({ url }) => window.open(url)}
      onMessage={async (params) => console.log('Message:', params)}
    />
  );
}
```

**UIResourceRenderer (传统 MCP-UI)：**
```typescript
import { UIResourceRenderer } from '@mcp-ui/client';

<UIResourceRenderer
  resource={mcpResource.resource}
  onUIAction={(action) => console.log('Action:', action)}
/>
```

## 3. Archestra 代码结构分析

### 3.1 前端架构

**目录结构：**
```
platform/frontend/src/
├── app/
│   ├── chat/                    # 聊天页面
│   │   ├── page.tsx            # 主聊天页面
│   │   ├── prompt-input.tsx    # 输入组件
│   │   └── browser-preview/    # 浏览器预览
│   ├── tools/                   # 工具管理
│   └── mcp-catalog/            # MCP 目录
├── components/
│   ├── ai-elements/            # AI 元素组件
│   │   ├── tool.tsx           # 工具渲染
│   │   ├── message.tsx        # 消息渲染
│   │   └── conversation.tsx   # 对话容器
│   └── chat/
│       ├── chat-messages.tsx   # 聊天消息
│       └── chat-tools-display.tsx # 工具显示
└── lib/
    ├── chat.query.ts          # 聊天 API
    └── tool-related queries   # 工具相关查询
```

### 3.2 消息渲染流程

**chat-messages.tsx 关键逻辑：**

1. **消息部分类型处理：**
```typescript
message.parts?.map((part, i) => {
  switch (part.type) {
    case "text":
      // 渲染文本消息
    case "reasoning":
      // 渲染推理内容
    case "file":
      // 渲染文件附件
    case "dynamic-tool":
      // 渲染动态工具
    default:
      // 处理工具调用 (type: "tool-{toolName}")
  }
})
```

2. **工具渲染 (MessageTool 组件)：**
```typescript
function MessageTool({ part, toolResultPart, toolName, agentId }) {
  return (
    <Tool>
      <ToolHeader type={type} state={state} />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput output={toolResultPart?.output} />
      </ToolContent>
    </Tool>
  );
}
```

### 3.3 后端架构

**MCP 客户端 (backend/src/clients/mcp-client.ts)：**

- **McpClient 类**: 管理 MCP 连接和工具调用
- **连接管理**: 支持 HTTP 和 stdio 传输
- **会话缓存**: 使用 connectionKey 缓存连接
- **工具调用**: `executeToolCall` 方法执行工具

**关键方法：**
```typescript
class McpClient {
  // 执行工具调用
  async executeToolCall(toolCall, agentId, tokenAuth, options)
  
  // 获取或创建客户端
  private async getOrCreateClient(connectionKey, transport)
  
  // 获取传输层
  private async getTransport(catalogItem, targetMcpServerId, secrets)
}
```

### 3.4 数据库模型

**相关表：**
- `mcp_servers` - MCP 服务器配置
- `tools` - 工具定义
- `agent_tools` - Agent 工具关联
- `mcp_tool_calls` - 工具调用日志
- `internal_mcp_catalogs` - MCP 目录

## 4. 集成方案设计

### 4.1 后端集成

**1. 扩展工具元数据支持：**

```typescript
// backend/src/types.ts
interface CommonMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: {
    ui?: {
      resourceUri: string;
      permissions?: string[];
      csp?: Record<string, string[]>;
    }
  };
}
```

**2. 添加 UI 资源路由：**

```typescript
// backend/src/routes/mcp-apps.ts
import { registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';

// 注册 UI 资源端点
app.get('/v1/mcp-apps/resources/:uri', async (req, res) => {
  // 获取并返回 UI 资源
});
```

**3. 修改工具注册逻辑：**

```typescript
// 在 mcp-client.ts 中，连接时获取工具的 _meta 信息
async connectAndGetTools(params) {
  const toolsResult = await client.listTools();
  return toolsResult.tools.map((tool: Tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    _meta: tool._meta,  // 传递 UI 元数据
  }));
}
```

### 4.2 前端集成

**1. 创建 MCP App 渲染组件：**

```typescript
// frontend/src/components/mcp-app/mcp-app-renderer.tsx
import { AppRenderer } from '@mcp-ui/client';

interface McpAppRendererProps {
  resourceUri: string;
  toolInput: unknown;
  toolResult: unknown;
}

export function McpAppRenderer({ resourceUri, toolInput, toolResult }: McpAppRendererProps) {
  return (
    <div className="mcp-app-container">
      <AppRenderer
        client={mcpClient}
        resourceUri={resourceUri}
        toolInput={toolInput}
        toolResult={toolResult}
        sandbox={{ 
          url: '/mcp-app-sandbox.html',
          csp: {
            'default-src': "'self'",
            'script-src': "'self' 'unsafe-inline'",
          }
        }}
        onOpenLink={({ url }) => window.open(url, '_blank')}
        onMessage={handleAppMessage}
      />
    </div>
  );
}
```

**2. 修改工具渲染逻辑：**

```typescript
// frontend/src/components/ai-elements/tool.tsx
// 在 ToolOutput 组件中检测 MCP App 资源

export const ToolOutput = ({ output, ...props }) => {
  // 检测是否是 MCP App 资源
  const mcpAppResource = detectMcpAppResource(output);
  
  if (mcpAppResource) {
    return (
      <McpAppRenderer
        resourceUri={mcpAppResource.uri}
        toolInput={props.toolInput}
        toolResult={output}
      />
    );
  }
  
  // 原有渲染逻辑
  return <OriginalToolOutput output={output} {...props} />;
};
```

**3. 修改消息渲染检测：**

```typescript
// frontend/src/components/chat/chat-messages.tsx
// 在 MessageTool 组件中添加 MCP App 检测

function MessageTool({ part, toolResultPart, toolName }) {
  // 检查工具是否有 _meta.ui
  const hasMcpApp = part._meta?.ui?.resourceUri;
  
  if (hasMcpApp && toolResultPart) {
    return (
      <Tool>
        <ToolHeader type={toolName} state="output-available" />
        <ToolContent>
          <McpAppRenderer
            resourceUri={part._meta.ui.resourceUri}
            toolInput={part.input}
            toolResult={toolResultPart.output}
          />
        </ToolContent>
      </Tool>
    );
  }
  
  // 原有工具渲染
  return <OriginalMessageTool ... />;
}
```

### 4.3 数据库迁移

```sql
-- 添加 _meta 字段到 tools 表
ALTER TABLE tools ADD COLUMN meta JSONB DEFAULT NULL;

-- 或者创建单独的 MCP App 配置表
CREATE TABLE mcp_app_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id UUID REFERENCES tools(id) ON DELETE CASCADE,
  resource_uri VARCHAR(255) NOT NULL,
  permissions JSONB DEFAULT '[]',
  csp_config JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### 4.4 API 设计

**获取 UI 资源：**
```typescript
// GET /api/mcp-apps/resources/:encodedUri
Response: {
  resource: {
    uri: string;
    mimeType: string;
    text?: string;
    blob?: string;
  }
}
```

**工具调用返回 MCP App：**
```typescript
// POST /api/chat/tools/call
Response: {
  content: [
    { type: 'text', text: '...' },
    { 
      type: 'resource',
      resource: {
        uri: 'ui://server/app',
        mimeType: 'text/html;profile=mcp-app',
        text: '<html>...</html>'
      }
    }
  ],
  _meta: {
    ui: {
      resourceUri: 'ui://server/app'
    }
  }
}
```

## 5. 实现优先级

### Phase 1: 基础支持
1. 后端：解析和存储工具的 `_meta.ui` 信息
2. 后端：添加 UI 资源获取 API
3. 前端：创建 McpAppRenderer 组件
4. 前端：在工具输出中渲染 MCP App

### Phase 2: 完整集成
1. 支持双向通信（工具调用、消息发送）
2. 实现权限请求处理
3. 支持 CSP 配置
4. 添加沙盒安全策略

### Phase 3: 高级功能
1. 支持 Remote DOM
2. 实现 UI 预加载
3. 支持流式工具输入
4. 优化性能和缓存

## 6. 参考资源

- **MCP Apps 规范**: https://modelcontextprotocol.io/docs/extensions/apps
- **MCP Apps 完整文档**: https://modelcontextprotocol.github.io/ext-apps
- **mcp-ui SDK**: https://github.com/MCP-UI-Org/mcp-ui
- **Archestra Issue**: https://github.com/archestra-ai/archestra/issues/1301
