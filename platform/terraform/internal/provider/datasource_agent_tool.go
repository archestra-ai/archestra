package provider

import (
	"context"
	"fmt"

	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var _ datasource.DataSource = &AgentToolDataSource{}

func NewAgentToolDataSource() datasource.DataSource {
	return &AgentToolDataSource{}
}

type AgentToolDataSource struct {
	client *client.Client
}

type AgentToolDataSourceModel struct {
	ID                                  types.String `tfsdk:"id"`
	AgentID                             types.String `tfsdk:"agent_id"`
	ToolID                              types.String `tfsdk:"tool_id"`
	ToolName                            types.String `tfsdk:"tool_name"`
	AllowUsageWhenUntrustedDataIsPresent types.Bool   `tfsdk:"allow_usage_when_untrusted_data_is_present"`
	ToolResultTreatment                 types.String `tfsdk:"tool_result_treatment"`
	ResponseModifierTemplate            types.String `tfsdk:"response_modifier_template"`
}

func (d *AgentToolDataSource) Metadata(ctx context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_agent_tool"
}

func (d *AgentToolDataSource) Schema(ctx context.Context, req datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Fetches an agent tool by agent ID and tool name. This data source is useful for " +
			"looking up the agent_tool_id needed to create trusted data policies and tool invocation policies.",

		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				MarkdownDescription: "Agent tool identifier (use this for policy agent_tool_id)",
				Computed:            true,
			},
			"agent_id": schema.StringAttribute{
				MarkdownDescription: "The agent ID",
				Required:            true,
			},
			"tool_name": schema.StringAttribute{
				MarkdownDescription: "The name of the tool",
				Required:            true,
			},
			"tool_id": schema.StringAttribute{
				MarkdownDescription: "The tool ID",
				Computed:            true,
			},
			"allow_usage_when_untrusted_data_is_present": schema.BoolAttribute{
				MarkdownDescription: "Whether to allow tool usage when untrusted data is present",
				Computed:            true,
			},
			"tool_result_treatment": schema.StringAttribute{
				MarkdownDescription: "How to treat tool results (trusted/untrusted)",
				Computed:            true,
			},
			"response_modifier_template": schema.StringAttribute{
				MarkdownDescription: "Optional response modifier template",
				Computed:            true,
			},
		},
	}
}

func (d *AgentToolDataSource) Configure(ctx context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}

	client, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Data Source Configure Type",
			fmt.Sprintf("Expected *client.Client, got: %T", req.ProviderData),
		)
		return
	}

	d.client = client
}

func (d *AgentToolDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var data AgentToolDataSourceModel

	resp.Diagnostics.Append(req.Config.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	agentTool, err := d.client.GetAgentToolByAgentAndToolName(ctx, data.AgentID.ValueString(), data.ToolName.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to read agent tool, got error: %s", err))
		return
	}

	data.ID = types.StringValue(agentTool.ID)
	data.ToolID = types.StringValue(agentTool.ToolID)
	data.AllowUsageWhenUntrustedDataIsPresent = types.BoolValue(agentTool.AllowUsageWhenUntrustedDataIsPresent)
	data.ToolResultTreatment = types.StringValue(agentTool.ToolResultTreatment)

	if agentTool.ResponseModifierTemplate != nil {
		data.ResponseModifierTemplate = types.StringValue(*agentTool.ResponseModifierTemplate)
	} else {
		data.ResponseModifierTemplate = types.StringNull()
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}
