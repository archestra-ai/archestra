terraform {
  required_providers {
    archestra = {
      source = "archestra-ai/archestra"
    }
  }
}

provider "archestra" {
  base_url = "http://localhost:9000"
  api_key  = var.archestra_api_key
}

variable "archestra_api_key" {
  description = "Archestra API key"
  type        = string
  sensitive   = true
}

# Create an agent
resource "archestra_agent" "example" {
  name       = "example-agent"
  is_demo    = false
  is_default = false
}

# Create an MCP server installation
resource "archestra_mcp_server_installation" "example" {
  name = "example-mcp-server"
}

# Create a user
resource "archestra_user" "example" {
  name           = "John Doe"
  email          = "john@example.com"
  email_verified = true
  role           = "admin"
}

# Create a team with members
resource "archestra_team" "example" {
  name            = "Engineering"
  description     = "Engineering team"
  organization_id = "org-123"
  created_by      = archestra_user.example.id

  members = [
    {
      user_id = archestra_user.example.id
      role    = "admin"
    }
  ]
}

# Data source examples
data "archestra_user" "lookup" {
  id = archestra_user.example.id
}

data "archestra_team" "lookup" {
  id = archestra_team.example.id
}

output "user_email" {
  value = data.archestra_user.lookup.email
}

output "team_name" {
  value = data.archestra_team.lookup.name
}
