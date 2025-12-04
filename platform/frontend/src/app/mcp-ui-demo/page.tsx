"use client";

import { useCallback, useState } from "react";
import { McpUiWrapper } from "@/components/ai-elements/mcp-ui-wrapper";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserIcon, MessageSquare, Zap, Settings } from "lucide-react";

const DEMO_USERS = [
  { id: "user-1", name: "Alice", color: "bg-blue-500" },
  { id: "user-2", name: "Bob", color: "bg-green-500" },
  { id: "user-3", name: "Charlie", color: "bg-purple-500" },
  { id: "user-4", name: "Diana", color: "bg-orange-500" },
];

const DEMO_MCP_UI_RESOURCES = {
  weatherWidget: {
    uri: "ui://weather-widget/1",
    mimeType: "text/html" as const,
    text: `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; min-height: 200px; }
    .weather-card { background: rgba(255,255,255,0.2); border-radius: 16px; padding: 20px; backdrop-filter: blur(10px); }
    h2 { margin: 0 0 10px 0; font-size: 24px; }
    .temp { font-size: 48px; font-weight: bold; }
    .details { display: flex; gap: 20px; margin-top: 15px; }
    .detail { text-align: center; }
    .label { font-size: 12px; opacity: 0.8; }
    button { background: white; color: #667eea; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; margin-top: 15px; font-weight: 600; }
    button:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="weather-card">
    <h2>San Francisco</h2>
    <div class="temp">72&deg;F</div>
    <div class="details">
      <div class="detail"><div class="label">Humidity</div><div>65%</div></div>
      <div class="detail"><div class="label">Wind</div><div>12 mph</div></div>
      <div class="detail"><div class="label">UV Index</div><div>5</div></div>
    </div>
    <button onclick="window.parent.postMessage({type:'tool',payload:{toolName:'refreshWeather',params:{city:'San Francisco'}}}, '*')">Refresh Weather</button>
  </div>
  <script>
    window.parent.postMessage({type:'ui-lifecycle-iframe-ready'}, '*');
    window.addEventListener('message', (e) => {
      if (e.data.type === 'ui-lifecycle-iframe-authenticated') {
        console.log('MCP UI authenticated with nonce');
      }
    });
  </script>
</body>
</html>`,
    _meta: { "mcpui.dev/ui-preferred-frame-size": { width: 400, height: 280 } },
  },
  taskManager: {
    uri: "ui://task-manager/1",
    mimeType: "text/html" as const,
    text: `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f8fafc; min-height: 300px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    h2 { margin: 0; color: #1e293b; }
    .task-list { display: flex; flex-direction: column; gap: 10px; }
    .task { background: white; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; align-items: center; gap: 12px; }
    .checkbox { width: 20px; height: 20px; border: 2px solid #3b82f6; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .checkbox.done { background: #3b82f6; }
    .checkbox.done::after { content: '✓'; color: white; font-size: 14px; }
    .task-text { flex: 1; }
    .task.done .task-text { text-decoration: line-through; opacity: 0.5; }
    .priority { font-size: 12px; padding: 4px 8px; border-radius: 4px; }
    .priority.high { background: #fee2e2; color: #dc2626; }
    .priority.medium { background: #fef3c7; color: #d97706; }
    .priority.low { background: #dcfce7; color: #16a34a; }
    .add-btn { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: 600; }
    .add-btn:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="header">
    <h2>Today's Tasks</h2>
    <button class="add-btn" onclick="addTask()">+ Add Task</button>
  </div>
  <div class="task-list" id="tasks">
    <div class="task"><div class="checkbox done"></div><span class="task-text">Review MCP UI documentation</span><span class="priority high">High</span></div>
    <div class="task"><div class="checkbox"></div><span class="task-text">Implement postMessage protocol</span><span class="priority high">High</span></div>
    <div class="task"><div class="checkbox"></div><span class="task-text">Test with demo servers</span><span class="priority medium">Medium</span></div>
    <div class="task"><div class="checkbox done"></div><span class="task-text">Update documentation</span><span class="priority low">Low</span></div>
  </div>
  <script>
    window.parent.postMessage({type:'ui-lifecycle-iframe-ready'}, '*');
    function addTask() {
      window.parent.postMessage({type:'prompt',payload:{promptName:'createTask',params:{}}}, '*');
    }
    document.querySelectorAll('.checkbox').forEach(cb => {
      cb.addEventListener('click', function() {
        const task = this.parentElement;
        this.classList.toggle('done');
        task.classList.toggle('done');
        window.parent.postMessage({type:'tool',payload:{toolName:'toggleTask',params:{}}}, '*');
      });
    });
  </script>
</body>
</html>`,
    _meta: { "mcpui.dev/ui-preferred-frame-size": { width: 500, height: 350 } },
  },
  dataChart: {
    uri: "ui://data-chart/1",
    mimeType: "text/html" as const,
    text: `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: white; }
    h3 { margin: 0 0 20px 0; color: #1e293b; }
    .chart { display: flex; align-items: end; gap: 15px; height: 200px; padding: 20px; background: #f8fafc; border-radius: 12px; }
    .bar-container { display: flex; flex-direction: column; align-items: center; gap: 8px; }
    .bar { width: 40px; background: linear-gradient(to top, #3b82f6, #60a5fa); border-radius: 4px 4px 0 0; transition: height 0.3s; }
    .label { font-size: 12px; color: #64748b; }
    .value { font-size: 14px; font-weight: 600; color: #1e293b; }
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    button { padding: 8px 16px; border-radius: 6px; border: 1px solid #e2e8f0; background: white; cursor: pointer; font-size: 14px; }
    button:hover { background: #f1f5f9; }
    button.primary { background: #3b82f6; color: white; border: none; }
    button.primary:hover { background: #2563eb; }
  </style>
</head>
<body>
  <h3>Weekly Performance</h3>
  <div class="chart">
    <div class="bar-container"><div class="value">85</div><div class="bar" style="height:170px"></div><div class="label">Mon</div></div>
    <div class="bar-container"><div class="value">92</div><div class="bar" style="height:184px"></div><div class="label">Tue</div></div>
    <div class="bar-container"><div class="value">78</div><div class="bar" style="height:156px"></div><div class="label">Wed</div></div>
    <div class="bar-container"><div class="value">95</div><div class="bar" style="height:190px"></div><div class="label">Thu</div></div>
    <div class="bar-container"><div class="value">88</div><div class="bar" style="height:176px"></div><div class="label">Fri</div></div>
  </div>
  <div class="actions">
    <button onclick="window.parent.postMessage({type:'tool',payload:{toolName:'exportData',params:{format:'csv'}}}, '*')">Export CSV</button>
    <button onclick="window.parent.postMessage({type:'tool',payload:{toolName:'exportData',params:{format:'pdf'}}}, '*')">Export PDF</button>
    <button class="primary" onclick="window.parent.postMessage({type:'intent',payload:{intent:'viewDetails',params:{week:'current'}}}, '*')">View Details</button>
  </div>
  <script>window.parent.postMessage({type:'ui-lifecycle-iframe-ready'}, '*');</script>
</body>
</html>`,
    _meta: { "mcpui.dev/ui-preferred-frame-size": { width: 450, height: 350 } },
  },
};

interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  content: string;
  timestamp: Date;
  toolOutput?: typeof DEMO_MCP_UI_RESOURCES.weatherWidget;
}

export default function McpUiDemoPage() {
  const [activeUser, setActiveUser] = useState(DEMO_USERS[0]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "1",
      userId: "user-1",
      userName: "Alice",
      content: "Can you show me the weather?",
      timestamp: new Date(Date.now() - 300000),
    },
    {
      id: "2",
      userId: "assistant",
      userName: "Assistant",
      content: "Here's the current weather for San Francisco:",
      timestamp: new Date(Date.now() - 290000),
      toolOutput: DEMO_MCP_UI_RESOURCES.weatherWidget,
    },
    {
      id: "3",
      userId: "user-2",
      userName: "Bob",
      content: "What tasks do I have today?",
      timestamp: new Date(Date.now() - 200000),
    },
    {
      id: "4",
      userId: "assistant",
      userName: "Assistant",
      content: "Here are your tasks for today:",
      timestamp: new Date(Date.now() - 190000),
      toolOutput: DEMO_MCP_UI_RESOURCES.taskManager,
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [actionLog, setActionLog] = useState<string[]>([]);

  const handleToolCall = useCallback(async (toolName: string, params: Record<string, unknown>) => {
    const log = `Tool called: ${toolName} with params: ${JSON.stringify(params)}`;
    setActionLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${log}`]);
    return { success: true, message: `Tool ${toolName} executed successfully` };
  }, []);

  const handlePrompt = useCallback(async (promptName: string, params: Record<string, unknown>) => {
    const log = `Prompt triggered: ${promptName} with params: ${JSON.stringify(params)}`;
    setActionLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${log}`]);
    return { response: "Prompt processed" };
  }, []);

  const handleIntent = useCallback((intent: string, params: Record<string, unknown>) => {
    const log = `Intent received: ${intent} with params: ${JSON.stringify(params)}`;
    setActionLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${log}`]);
  }, []);

  const sendMessage = useCallback(() => {
    if (!inputValue.trim()) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      userId: activeUser.id,
      userName: activeUser.name,
      content: inputValue,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);

    if (inputValue.toLowerCase().includes("weather")) {
      setTimeout(() => {
        setMessages(prev => [...prev, {
          id: (Date.now() + 1).toString(),
          userId: "assistant",
          userName: "Assistant",
          content: "Here's the weather information:",
          timestamp: new Date(),
          toolOutput: DEMO_MCP_UI_RESOURCES.weatherWidget,
        }]);
      }, 500);
    } else if (inputValue.toLowerCase().includes("task")) {
      setTimeout(() => {
        setMessages(prev => [...prev, {
          id: (Date.now() + 1).toString(),
          userId: "assistant",
          userName: "Assistant",
          content: "Here are your tasks:",
          timestamp: new Date(),
          toolOutput: DEMO_MCP_UI_RESOURCES.taskManager,
        }]);
      }, 500);
    } else if (inputValue.toLowerCase().includes("chart") || inputValue.toLowerCase().includes("data")) {
      setTimeout(() => {
        setMessages(prev => [...prev, {
          id: (Date.now() + 1).toString(),
          userId: "assistant",
          userName: "Assistant",
          content: "Here's your performance data:",
          timestamp: new Date(),
          toolOutput: DEMO_MCP_UI_RESOURCES.dataChart,
        }]);
      }, 500);
    } else {
      setTimeout(() => {
        setMessages(prev => [...prev, {
          id: (Date.now() + 1).toString(),
          userId: "assistant",
          userName: "Assistant",
          content: `Hello ${activeUser.name}! Try asking about "weather", "tasks", or "chart" to see MCP UI demos.`,
          timestamp: new Date(),
        }]);
      }, 500);
    }

    setInputValue("");
  }, [inputValue, activeUser]);

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-6 px-4">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">MCP UI Demo</h1>
          <p className="text-muted-foreground">
            Demonstration of MCP UI integration for the Archestra platform bounty ($900)
          </p>
        </div>

        <div className="mb-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <UserIcon className="h-5 w-5" />
                Switch User
              </CardTitle>
              <CardDescription>Click to switch between demo users (no password required)</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-3 flex-wrap">
                {DEMO_USERS.map((user) => (
                  <Button
                    key={user.id}
                    variant={activeUser.id === user.id ? "default" : "outline"}
                    onClick={() => setActiveUser(user)}
                    className="flex items-center gap-2"
                  >
                    <div className={`w-3 h-3 rounded-full ${user.color}`} />
                    {user.name}
                    {activeUser.id === user.id && <Badge variant="secondary" className="ml-1">Active</Badge>}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <Tabs defaultValue="chat">
              <TabsList className="mb-4">
                <TabsTrigger value="chat" className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  Live Chat
                </TabsTrigger>
                <TabsTrigger value="widgets" className="flex items-center gap-2">
                  <Zap className="h-4 w-4" />
                  MCP UI Widgets
                </TabsTrigger>
              </TabsList>

              <TabsContent value="chat">
                <Card>
                  <CardContent className="p-0">
                    <div className="h-[500px] overflow-y-auto p-4 space-y-4">
                      {messages.map((msg) => (
                        <div
                          key={msg.id}
                          className={`flex ${msg.userId === activeUser.id ? "justify-end" : "justify-start"}`}
                        >
                          <div className={`max-w-[80%] ${msg.userId === "assistant" ? "w-full" : ""}`}>
                            <div className="flex items-center gap-2 mb-1">
                              <div className={`w-2 h-2 rounded-full ${
                                DEMO_USERS.find(u => u.id === msg.userId)?.color || "bg-gray-500"
                              }`} />
                              <span className="text-xs text-muted-foreground">{msg.userName}</span>
                              <span className="text-xs text-muted-foreground">
                                {msg.timestamp.toLocaleTimeString()}
                              </span>
                            </div>
                            <div className={`rounded-lg p-3 ${
                              msg.userId === activeUser.id
                                ? "bg-primary text-primary-foreground"
                                : msg.userId === "assistant"
                                  ? "bg-muted"
                                  : "bg-secondary"
                            }`}>
                              <p className="text-sm">{msg.content}</p>
                            </div>
                            {msg.toolOutput && (
                              <div className="mt-3">
                                <McpUiWrapper
                                  resource={msg.toolOutput}
                                  onToolCall={handleToolCall}
                                  onPrompt={handlePrompt}
                                  onIntent={handleIntent}
                                  className="rounded-lg overflow-hidden shadow-lg"
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="border-t p-4">
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                          placeholder={`Message as ${activeUser.name}... (try "weather", "tasks", or "chart")`}
                          className="flex-1 px-4 py-2 rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        <Button onClick={sendMessage}>Send</Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="widgets">
                <div className="grid md:grid-cols-2 gap-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Weather Widget</CardTitle>
                      <CardDescription>Interactive weather display with refresh action</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <McpUiWrapper
                        resource={DEMO_MCP_UI_RESOURCES.weatherWidget}
                        onToolCall={handleToolCall}
                        onPrompt={handlePrompt}
                        onIntent={handleIntent}
                      />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Task Manager</CardTitle>
                      <CardDescription>Interactive task list with prompts</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <McpUiWrapper
                        resource={DEMO_MCP_UI_RESOURCES.taskManager}
                        onToolCall={handleToolCall}
                        onPrompt={handlePrompt}
                        onIntent={handleIntent}
                      />
                    </CardContent>
                  </Card>
                  <Card className="md:col-span-2">
                    <CardHeader>
                      <CardTitle className="text-base">Data Chart</CardTitle>
                      <CardDescription>Interactive chart with export and intent actions</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <McpUiWrapper
                        resource={DEMO_MCP_UI_RESOURCES.dataChart}
                        onToolCall={handleToolCall}
                        onPrompt={handlePrompt}
                        onIntent={handleIntent}
                      />
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
            </Tabs>
          </div>

          <div>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Settings className="h-5 w-5" />
                  Action Log
                </CardTitle>
                <CardDescription>
                  MCP UI actions from embedded iframes
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[400px] overflow-y-auto bg-muted/50 rounded-lg p-3 font-mono text-xs">
                  {actionLog.length === 0 ? (
                    <p className="text-muted-foreground">
                      Interact with the MCP UI widgets to see action logs here...
                    </p>
                  ) : (
                    actionLog.map((log, idx) => (
                      <div key={idx} className="mb-2 p-2 bg-background rounded border">
                        {log}
                      </div>
                    ))
                  )}
                </div>
                {actionLog.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 w-full"
                    onClick={() => setActionLog([])}
                  >
                    Clear Log
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card className="mt-4">
              <CardHeader>
                <CardTitle className="text-lg">Bounty Requirements</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge variant="default" className="bg-green-500">Done</Badge>
                  <span className="text-sm">MCP UI in Archestra Chat UI</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="default" className="bg-green-500">Done</Badge>
                  <span className="text-sm">postMessage protocol</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="default" className="bg-green-500">Done</Badge>
                  <span className="text-sm">UIResource detection</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="default" className="bg-green-500">Done</Badge>
                  <span className="text-sm">Multi-user demo</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Pending</Badge>
                  <span className="text-sm">MCP Gateway preservation</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Pending</Badge>
                  <span className="text-sm">LLM Gateway support</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
