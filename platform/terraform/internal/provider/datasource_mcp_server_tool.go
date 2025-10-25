package provider

import (
	"context"
	"fmt"

	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var _ datasource.DataSource = &MCPServerToolDataSource{}

func NewMCPServerToolDataSource() datasource.DataSource {
	return &MCPServerToolDataSource{}
}

type MCPServerToolDataSource struct {
	client *client.ClientWithResponses
}

type MCPServerToolDataSourceModel struct {
	ID          types.String `tfsdk:"id"`
	MCPServerID types.String `tfsdk:"mcp_server_id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
}

func (d *MCPServerToolDataSource) Metadata(ctx context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_mcp_server_tool"
}

func (d *MCPServerToolDataSource) Schema(ctx context.Context, req datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Fetches a tool from an MCP server by MCP server ID and tool name. " +
			"This data source is useful for looking up tools provided by MCP servers.",

		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				MarkdownDescription: "Tool identifier",
				Computed:            true,
			},
			"mcp_server_id": schema.StringAttribute{
				MarkdownDescription: "The MCP server ID",
				Required:            true,
			},
			"name": schema.StringAttribute{
				MarkdownDescription: "The name of the tool",
				Required:            true,
			},
			"description": schema.StringAttribute{
				MarkdownDescription: "Tool description",
				Computed:            true,
			},
		},
	}
}

func (d *MCPServerToolDataSource) Configure(ctx context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}

	client, ok := req.ProviderData.(*client.ClientWithResponses)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Data Source Configure Type",
			fmt.Sprintf("Expected *client.ClientWithResponses, got: %T", req.ProviderData),
		)
		return
	}

	d.client = client
}

func (d *MCPServerToolDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var data MCPServerToolDataSourceModel

	resp.Diagnostics.Append(req.Config.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Get all tools
	toolsResp, err := d.client.GetToolsWithResponse(ctx)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to read tools, got error: %s", err))
		return
	}

	if toolsResp.JSON200 == nil {
		resp.Diagnostics.AddError("Unexpected API Response", fmt.Sprintf("Expected 200 OK, got status %d", toolsResp.StatusCode()))
		return
	}

	// Filter by MCP server ID and tool name
	targetMCPServerID := data.MCPServerID.ValueString()
	targetToolName := data.Name.ValueString()

	var foundIndex = -1
	for i := range *toolsResp.JSON200 {
		tool := &(*toolsResp.JSON200)[i]

		// Check if tool has mcpServer and matches our criteria
		if tool.McpServer != nil && tool.McpServer.Id == targetMCPServerID && tool.Name == targetToolName {
			foundIndex = i
			break
		}
	}

	if foundIndex == -1 {
		resp.Diagnostics.AddError("Not Found", fmt.Sprintf("Tool '%s' not found for MCP server %s", targetToolName, targetMCPServerID))
		return
	}

	foundTool := (*toolsResp.JSON200)[foundIndex]

	// Map to state
	data.ID = types.StringValue(foundTool.Id.String())
	if foundTool.Description != nil {
		data.Description = types.StringValue(*foundTool.Description)
	} else {
		data.Description = types.StringNull()
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}
