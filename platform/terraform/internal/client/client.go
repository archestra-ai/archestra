package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Client is the Archestra API client
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

// NewClient creates a new Archestra API client
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL: baseURL,
		APIKey:  apiKey,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// doRequest performs an HTTP request
func (c *Client) doRequest(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	var reqBody io.Reader
	if body != nil {
		jsonData, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonData)
	}

	reqURL, err := url.JoinPath(c.BaseURL, path)
	if err != nil {
		return nil, fmt.Errorf("failed to build request URL: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, method, reqURL, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.APIKey))

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}

	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API request failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return resp, nil
}

// decodeResponse decodes a JSON response
func decodeResponse(resp *http.Response, v interface{}) error {
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(v)
}

// Agent methods

func (c *Client) GetAgent(ctx context.Context, id string) (*Agent, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/agents/%s", id), nil)
	if err != nil {
		return nil, err
	}

	var agent Agent
	if err := decodeResponse(resp, &agent); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &agent, nil
}

func (c *Client) CreateAgent(ctx context.Context, agent *Agent) (*Agent, error) {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/agents", agent)
	if err != nil {
		return nil, err
	}

	var created Agent
	if err := decodeResponse(resp, &created); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &created, nil
}

func (c *Client) UpdateAgent(ctx context.Context, id string, agent *Agent) (*Agent, error) {
	resp, err := c.doRequest(ctx, http.MethodPatch, fmt.Sprintf("/api/agents/%s", id), agent)
	if err != nil {
		return nil, err
	}

	var updated Agent
	if err := decodeResponse(resp, &updated); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &updated, nil
}

func (c *Client) DeleteAgent(ctx context.Context, id string) error {
	_, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/api/agents/%s", id), nil)
	return err
}

// MCP Server methods

func (c *Client) GetMCPServer(ctx context.Context, id string) (*MCPServer, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/mcp-servers/%s", id), nil)
	if err != nil {
		return nil, err
	}

	var server MCPServer
	if err := decodeResponse(resp, &server); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &server, nil
}

func (c *Client) CreateMCPServer(ctx context.Context, server *MCPServer) (*MCPServer, error) {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/mcp-servers", server)
	if err != nil {
		return nil, err
	}

	var created MCPServer
	if err := decodeResponse(resp, &created); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &created, nil
}

func (c *Client) UpdateMCPServer(ctx context.Context, id string, server *MCPServer) (*MCPServer, error) {
	resp, err := c.doRequest(ctx, http.MethodPatch, fmt.Sprintf("/api/mcp-servers/%s", id), server)
	if err != nil {
		return nil, err
	}

	var updated MCPServer
	if err := decodeResponse(resp, &updated); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &updated, nil
}

func (c *Client) DeleteMCPServer(ctx context.Context, id string) error {
	_, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/api/mcp-servers/%s", id), nil)
	return err
}

// Team methods

func (c *Client) GetTeam(ctx context.Context, id string) (*Team, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/teams/%s", id), nil)
	if err != nil {
		return nil, err
	}

	var team Team
	if err := decodeResponse(resp, &team); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &team, nil
}

func (c *Client) CreateTeam(ctx context.Context, team *Team) (*Team, error) {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/teams", team)
	if err != nil {
		return nil, err
	}

	var created Team
	if err := decodeResponse(resp, &created); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &created, nil
}

func (c *Client) UpdateTeam(ctx context.Context, id string, team *Team) (*Team, error) {
	resp, err := c.doRequest(ctx, http.MethodPatch, fmt.Sprintf("/api/teams/%s", id), team)
	if err != nil {
		return nil, err
	}

	var updated Team
	if err := decodeResponse(resp, &updated); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &updated, nil
}

func (c *Client) DeleteTeam(ctx context.Context, id string) error {
	_, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/api/teams/%s", id), nil)
	return err
}

func (c *Client) GetTeamMembers(ctx context.Context, teamID string) ([]TeamMember, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/teams/%s/members", teamID), nil)
	if err != nil {
		return nil, err
	}

	var members []TeamMember
	if err := decodeResponse(resp, &members); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return members, nil
}

func (c *Client) AddTeamMember(ctx context.Context, teamID, userID, role string) (*TeamMember, error) {
	member := map[string]string{
		"user_id": userID,
		"role":    role,
	}

	resp, err := c.doRequest(ctx, http.MethodPost, fmt.Sprintf("/api/teams/%s/members", teamID), member)
	if err != nil {
		return nil, err
	}

	var created TeamMember
	if err := decodeResponse(resp, &created); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &created, nil
}

func (c *Client) RemoveTeamMember(ctx context.Context, teamID, memberID string) error {
	_, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/api/teams/%s/members/%s", teamID, memberID), nil)
	return err
}

// User methods

func (c *Client) GetUser(ctx context.Context, id string) (*User, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/users/%s", id), nil)
	if err != nil {
		return nil, err
	}

	var user User
	if err := decodeResponse(resp, &user); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &user, nil
}

func (c *Client) CreateUser(ctx context.Context, user *User) (*User, error) {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/users", user)
	if err != nil {
		return nil, err
	}

	var created User
	if err := decodeResponse(resp, &created); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &created, nil
}

func (c *Client) UpdateUser(ctx context.Context, id string, user *User) (*User, error) {
	resp, err := c.doRequest(ctx, http.MethodPatch, fmt.Sprintf("/api/users/%s", id), user)
	if err != nil {
		return nil, err
	}

	var updated User
	if err := decodeResponse(resp, &updated); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &updated, nil
}

func (c *Client) DeleteUser(ctx context.Context, id string) error {
	_, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/api/users/%s", id), nil)
	return err
}

// Trusted Data Policy methods

func (c *Client) GetTrustedDataPolicy(ctx context.Context, id string) (*TrustedDataPolicy, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/autonomy-policies/trusted-data/%s", id), nil)
	if err != nil {
		return nil, err
	}

	var policy TrustedDataPolicy
	if err := decodeResponse(resp, &policy); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &policy, nil
}

func (c *Client) CreateTrustedDataPolicy(ctx context.Context, policy *TrustedDataPolicy) (*TrustedDataPolicy, error) {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/autonomy-policies/trusted-data", policy)
	if err != nil {
		return nil, err
	}

	var created TrustedDataPolicy
	if err := decodeResponse(resp, &created); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &created, nil
}

func (c *Client) UpdateTrustedDataPolicy(ctx context.Context, id string, policy *TrustedDataPolicy) (*TrustedDataPolicy, error) {
	resp, err := c.doRequest(ctx, http.MethodPatch, fmt.Sprintf("/api/autonomy-policies/trusted-data/%s", id), policy)
	if err != nil {
		return nil, err
	}

	var updated TrustedDataPolicy
	if err := decodeResponse(resp, &updated); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &updated, nil
}

func (c *Client) DeleteTrustedDataPolicy(ctx context.Context, id string) error {
	_, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/api/autonomy-policies/trusted-data/%s", id), nil)
	return err
}

// Tool Invocation Policy methods

func (c *Client) GetToolInvocationPolicy(ctx context.Context, id string) (*ToolInvocationPolicy, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/autonomy-policies/tool-invocation/%s", id), nil)
	if err != nil {
		return nil, err
	}

	var policy ToolInvocationPolicy
	if err := decodeResponse(resp, &policy); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &policy, nil
}

func (c *Client) CreateToolInvocationPolicy(ctx context.Context, policy *ToolInvocationPolicy) (*ToolInvocationPolicy, error) {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/autonomy-policies/tool-invocation", policy)
	if err != nil {
		return nil, err
	}

	var created ToolInvocationPolicy
	if err := decodeResponse(resp, &created); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &created, nil
}

func (c *Client) UpdateToolInvocationPolicy(ctx context.Context, id string, policy *ToolInvocationPolicy) (*ToolInvocationPolicy, error) {
	resp, err := c.doRequest(ctx, http.MethodPatch, fmt.Sprintf("/api/autonomy-policies/tool-invocation/%s", id), policy)
	if err != nil {
		return nil, err
	}

	var updated ToolInvocationPolicy
	if err := decodeResponse(resp, &updated); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &updated, nil
}

func (c *Client) DeleteToolInvocationPolicy(ctx context.Context, id string) error {
	_, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/api/autonomy-policies/tool-invocation/%s", id), nil)
	return err
}

// Tool methods

// ListToolsByMCPServer fetches tools for a specific MCP server
func (c *Client) ListToolsByMCPServer(ctx context.Context, mcpServerID string) ([]Tool, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/mcp-servers/%s/tools", mcpServerID), nil)
	if err != nil {
		return nil, err
	}

	var tools []Tool
	if err := decodeResponse(resp, &tools); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return tools, nil
}

// GetToolByMCPServerAndName fetches a specific tool by MCP server ID and tool name
func (c *Client) GetToolByMCPServerAndName(ctx context.Context, mcpServerID, toolName string) (*Tool, error) {
	tools, err := c.ListToolsByMCPServer(ctx, mcpServerID)
	if err != nil {
		return nil, err
	}

	for _, tool := range tools {
		if tool.Name == toolName {
			return &tool, nil
		}
	}

	return nil, fmt.Errorf("tool %s not found in MCP server %s", toolName, mcpServerID)
}

// AgentTool methods

// ListAgentTools fetches agent tools for a specific agent
func (c *Client) ListAgentTools(ctx context.Context, agentID string) ([]AgentTool, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/agents/%s/tools", agentID), nil)
	if err != nil {
		return nil, err
	}

	var agentTools []AgentTool
	if err := decodeResponse(resp, &agentTools); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return agentTools, nil
}

// GetAgentTool fetches a specific agent tool by ID
func (c *Client) GetAgentTool(ctx context.Context, agentToolID string) (*AgentTool, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/agent-tools/%s", agentToolID), nil)
	if err != nil {
		return nil, err
	}

	var agentTool AgentTool
	if err := decodeResponse(resp, &agentTool); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &agentTool, nil
}

// GetAgentToolByAgentAndToolName fetches a specific agent tool by agent ID and tool name
func (c *Client) GetAgentToolByAgentAndToolName(ctx context.Context, agentID, toolName string) (*AgentTool, error) {
	agentTools, err := c.ListAgentTools(ctx, agentID)
	if err != nil {
		return nil, err
	}

	// We need to also fetch the tool details to match by name
	for _, agentTool := range agentTools {
		// Fetch the tool to get its name
		tool, err := c.GetTool(ctx, agentTool.ToolID)
		if err != nil {
			continue // Skip if we can't fetch the tool
		}

		if tool.Name == toolName {
			return &agentTool, nil
		}
	}

	return nil, fmt.Errorf("agent tool with tool name %s not found for agent %s", toolName, agentID)
}

// GetTool fetches a specific tool by ID
func (c *Client) GetTool(ctx context.Context, toolID string) (*Tool, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/tools/%s", toolID), nil)
	if err != nil {
		return nil, err
	}

	var tool Tool
	if err := decodeResponse(resp, &tool); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &tool, nil
}
