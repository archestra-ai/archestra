package client

import "time"

// Agent represents an Archestra agent
type Agent struct {
	ID        string    `json:"id,omitempty"`
	Name      string    `json:"name"`
	IsDemo    bool      `json:"is_demo"`
	IsDefault bool      `json:"is_default"`
	CreatedAt time.Time `json:"created_at,omitempty"`
	UpdatedAt time.Time `json:"updated_at,omitempty"`
}

// MCPServer represents an MCP server installation
type MCPServer struct {
	ID        string                 `json:"id,omitempty"`
	Name      string                 `json:"name"`
	CatalogID *string                `json:"catalog_id,omitempty"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
	CreatedAt time.Time              `json:"created_at,omitempty"`
	UpdatedAt time.Time              `json:"updated_at,omitempty"`
}

// TrustedDataPolicy represents a trusted data policy
type TrustedDataPolicy struct {
	ID            string    `json:"id,omitempty"`
	AgentToolID   string    `json:"agent_tool_id"`
	Description   string    `json:"description"`
	AttributePath string    `json:"attribute_path"`
	Operator      string    `json:"operator"`
	Value         string    `json:"value"`
	Action        string    `json:"action"`
	CreatedAt     time.Time `json:"created_at,omitempty"`
	UpdatedAt     time.Time `json:"updated_at,omitempty"`
}

// ToolInvocationPolicy represents a tool invocation policy
type ToolInvocationPolicy struct {
	ID           string    `json:"id,omitempty"`
	AgentToolID  string    `json:"agent_tool_id"`
	ArgumentName string    `json:"argument_name"`
	Operator     string    `json:"operator"`
	Value        string    `json:"value"`
	Action       string    `json:"action"`
	Reason       *string   `json:"reason,omitempty"`
	CreatedAt    time.Time `json:"created_at,omitempty"`
	UpdatedAt    time.Time `json:"updated_at,omitempty"`
}

// Team represents a team
type Team struct {
	ID             string    `json:"id,omitempty"`
	Name           string    `json:"name"`
	Description    *string   `json:"description,omitempty"`
	OrganizationID string    `json:"organization_id"`
	CreatedBy      string    `json:"created_by"`
	CreatedAt      time.Time `json:"created_at,omitempty"`
	UpdatedAt      time.Time `json:"updated_at,omitempty"`
}

// TeamMember represents a team member
type TeamMember struct {
	ID        string    `json:"id,omitempty"`
	TeamID    string    `json:"team_id"`
	UserID    string    `json:"user_id"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at,omitempty"`
}

// User represents a user
type User struct {
	ID            string     `json:"id,omitempty"`
	Name          string     `json:"name"`
	Email         string     `json:"email"`
	EmailVerified bool       `json:"email_verified"`
	Image         *string    `json:"image,omitempty"`
	Role          *string    `json:"role,omitempty"`
	Banned        bool       `json:"banned"`
	BanReason     *string    `json:"ban_reason,omitempty"`
	BanExpires    *time.Time `json:"ban_expires,omitempty"`
	CreatedAt     time.Time  `json:"created_at,omitempty"`
	UpdatedAt     time.Time  `json:"updated_at,omitempty"`
}

// Tool represents a tool (from either MCP server or agent proxy)
type Tool struct {
	ID          string                 `json:"id,omitempty"`
	AgentID     *string                `json:"agent_id,omitempty"`
	MCPServerID *string                `json:"mcp_server_id,omitempty"`
	Name        string                 `json:"name"`
	Parameters  map[string]interface{} `json:"parameters,omitempty"`
	Description *string                `json:"description,omitempty"`
	CreatedAt   time.Time              `json:"created_at,omitempty"`
	UpdatedAt   time.Time              `json:"updated_at,omitempty"`
}

// AgentTool represents the agent-tool association with configuration
type AgentTool struct {
	ID                                  string    `json:"id,omitempty"`
	AgentID                             string    `json:"agent_id"`
	ToolID                              string    `json:"tool_id"`
	AllowUsageWhenUntrustedDataIsPresent bool      `json:"allow_usage_when_untrusted_data_is_present"`
	ToolResultTreatment                 string    `json:"tool_result_treatment"`
	ResponseModifierTemplate            *string   `json:"response_modifier_template,omitempty"`
	CreatedAt                           time.Time `json:"created_at,omitempty"`
	UpdatedAt                           time.Time `json:"updated_at,omitempty"`
}

// ListResponse represents a paginated list response
type ListResponse[T any] struct {
	Data       []T `json:"data"`
	TotalCount int `json:"total_count,omitempty"`
}
