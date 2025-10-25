# Terraform Provider for Archestra

This is a Terraform provider for managing Archestra resources.

## Building The Provider

```shell
go build -o terraform-provider-archestra
```

## Using the Provider

```hcl
terraform {
  required_providers {
    archestra = {
      source = "archestra-ai/archestra"
    }
  }
}

provider "archestra" {
  base_url = "http://localhost:9000"
  api_key  = "your-api-key"
}
```

## Resources

- `archestra_agent` - Manages an Archestra agent
- `archestra_mcp_server_installation` - Manages an MCP server installation
- `archestra_trusted_data_policy` - Manages a trusted data policy
- `archestra_tool_invocation_policy` - Manages a tool invocation policy
- `archestra_team` - Manages a team with members
- `archestra_user` - Manages a user

## Data Sources

- `archestra_team` - Retrieves team information
- `archestra_user` - Retrieves user information

## Development

To generate the API client from the OpenAPI specification:

```shell
make generate
```

To build the provider:

```shell
make build
```

To run tests:

```shell
make test
```
