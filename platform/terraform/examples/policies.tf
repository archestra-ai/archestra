# Example: Creating policies using agent_tool and mcp_server_tool data sources

# Create an agent
resource "archestra_agent" "production" {
  name       = "production-agent"
  is_demo    = false
  is_default = false
}

# Look up an agent tool by agent ID and tool name
# This is useful when you want to create policies for a specific tool
data "archestra_agent_tool" "file_operations" {
  agent_id  = archestra_agent.production.id
  tool_name = "write_file"
}

# Create a tool invocation policy that blocks writing to sensitive paths
resource "archestra_tool_invocation_policy" "block_sensitive_paths" {
  agent_tool_id = data.archestra_agent_tool.file_operations.id
  argument_name = "path"
  operator      = "contains"
  value         = "/etc/"
  action        = "deny"
  reason        = "Cannot write to system configuration directories"
}

# Create another policy to require approval for home directory writes
resource "archestra_tool_invocation_policy" "require_approval_home" {
  agent_tool_id = data.archestra_agent_tool.file_operations.id
  argument_name = "path"
  operator      = "contains"
  value         = "/home/"
  action        = "require_approval"
  reason        = "Writes to home directories require approval"
}

# Look up a tool from an agent that fetches external data
data "archestra_agent_tool" "fetch_url" {
  agent_id  = archestra_agent.production.id
  tool_name = "fetch_url"
}

# Create a trusted data policy to mark certain domains as trusted
resource "archestra_trusted_data_policy" "trust_company_api" {
  agent_tool_id   = data.archestra_agent_tool.fetch_url.id
  description     = "Trust data from company API"
  attribute_path  = "url"
  operator        = "contains"
  value           = "api.company.com"
  action          = "mark_as_trusted"
}

# Create a trusted data policy for verified sources
resource "archestra_trusted_data_policy" "trust_verified_source" {
  agent_tool_id   = data.archestra_agent_tool.fetch_url.id
  description     = "Trust data from verified source"
  attribute_path  = "url"
  operator        = "regex"
  value           = "^https://verified\\.company\\.com/.*$"
  action          = "mark_as_trusted"
}

# Example with MCP server tool
resource "archestra_mcp_server_installation" "filesystem" {
  name = "filesystem-mcp"
}

# Look up a tool from an MCP server
data "archestra_mcp_server_tool" "mcp_file_read" {
  mcp_server_id = archestra_mcp_server_installation.filesystem.id
  name          = "read_file"
}

# Output the tool IDs for reference
output "file_operations_tool_id" {
  value       = data.archestra_agent_tool.file_operations.id
  description = "The agent_tool_id for file operations"
}

output "fetch_url_tool_id" {
  value       = data.archestra_agent_tool.fetch_url.id
  description = "The agent_tool_id for URL fetching"
}

output "mcp_file_read_tool_id" {
  value       = data.archestra_mcp_server_tool.mcp_file_read.id
  description = "The tool_id for MCP file read operations"
}
