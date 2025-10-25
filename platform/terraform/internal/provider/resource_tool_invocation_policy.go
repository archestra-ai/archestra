package provider

import (
	"context"
	"fmt"

	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var _ resource.Resource = &ToolInvocationPolicyResource{}
var _ resource.ResourceWithImportState = &ToolInvocationPolicyResource{}

func NewToolInvocationPolicyResource() resource.Resource {
	return &ToolInvocationPolicyResource{}
}

type ToolInvocationPolicyResource struct {
	client *client.Client
}

type ToolInvocationPolicyResourceModel struct {
	ID           types.String `tfsdk:"id"`
	AgentToolID  types.String `tfsdk:"agent_tool_id"`
	ArgumentName types.String `tfsdk:"argument_name"`
	Operator     types.String `tfsdk:"operator"`
	Value        types.String `tfsdk:"value"`
	Action       types.String `tfsdk:"action"`
	Reason       types.String `tfsdk:"reason"`
}

func (r *ToolInvocationPolicyResource) Metadata(ctx context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_tool_invocation_policy"
}

func (r *ToolInvocationPolicyResource) Schema(ctx context.Context, req resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manages an Archestra tool invocation policy.",

		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Policy identifier",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"agent_tool_id": schema.StringAttribute{
				MarkdownDescription: "The agent tool ID this policy applies to",
				Required:            true,
			},
			"argument_name": schema.StringAttribute{
				MarkdownDescription: "The argument name to match",
				Required:            true,
			},
			"operator": schema.StringAttribute{
				MarkdownDescription: "The comparison operator (e.g., equals, contains, regex)",
				Required:            true,
			},
			"value": schema.StringAttribute{
				MarkdownDescription: "The value to compare against",
				Required:            true,
			},
			"action": schema.StringAttribute{
				MarkdownDescription: "The action to take (e.g., allow, deny, require_approval)",
				Required:            true,
			},
			"reason": schema.StringAttribute{
				MarkdownDescription: "Optional reason for the policy",
				Optional:            true,
			},
		},
	}
}

func (r *ToolInvocationPolicyResource) Configure(ctx context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}

	client, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Resource Configure Type",
			fmt.Sprintf("Expected *client.Client, got: %T", req.ProviderData),
		)
		return
	}

	r.client = client
}

func (r *ToolInvocationPolicyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var data ToolInvocationPolicyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	policy := &client.ToolInvocationPolicy{
		AgentToolID:  data.AgentToolID.ValueString(),
		ArgumentName: data.ArgumentName.ValueString(),
		Operator:     data.Operator.ValueString(),
		Value:        data.Value.ValueString(),
		Action:       data.Action.ValueString(),
	}

	if !data.Reason.IsNull() {
		reason := data.Reason.ValueString()
		policy.Reason = &reason
	}

	created, err := r.client.CreateToolInvocationPolicy(ctx, policy)
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to create tool invocation policy, got error: %s", err))
		return
	}

	data.ID = types.StringValue(created.ID)
	data.AgentToolID = types.StringValue(created.AgentToolID)
	data.ArgumentName = types.StringValue(created.ArgumentName)
	data.Operator = types.StringValue(created.Operator)
	data.Value = types.StringValue(created.Value)
	data.Action = types.StringValue(created.Action)
	if created.Reason != nil {
		data.Reason = types.StringValue(*created.Reason)
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *ToolInvocationPolicyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var data ToolInvocationPolicyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	policy, err := r.client.GetToolInvocationPolicy(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to read tool invocation policy, got error: %s", err))
		return
	}

	data.AgentToolID = types.StringValue(policy.AgentToolID)
	data.ArgumentName = types.StringValue(policy.ArgumentName)
	data.Operator = types.StringValue(policy.Operator)
	data.Value = types.StringValue(policy.Value)
	data.Action = types.StringValue(policy.Action)
	if policy.Reason != nil {
		data.Reason = types.StringValue(*policy.Reason)
	} else {
		data.Reason = types.StringNull()
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *ToolInvocationPolicyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var data ToolInvocationPolicyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	policy := &client.ToolInvocationPolicy{
		AgentToolID:  data.AgentToolID.ValueString(),
		ArgumentName: data.ArgumentName.ValueString(),
		Operator:     data.Operator.ValueString(),
		Value:        data.Value.ValueString(),
		Action:       data.Action.ValueString(),
	}

	if !data.Reason.IsNull() {
		reason := data.Reason.ValueString()
		policy.Reason = &reason
	}

	updated, err := r.client.UpdateToolInvocationPolicy(ctx, data.ID.ValueString(), policy)
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to update tool invocation policy, got error: %s", err))
		return
	}

	data.AgentToolID = types.StringValue(updated.AgentToolID)
	data.ArgumentName = types.StringValue(updated.ArgumentName)
	data.Operator = types.StringValue(updated.Operator)
	data.Value = types.StringValue(updated.Value)
	data.Action = types.StringValue(updated.Action)
	if updated.Reason != nil {
		data.Reason = types.StringValue(*updated.Reason)
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *ToolInvocationPolicyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var data ToolInvocationPolicyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeleteToolInvocationPolicy(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to delete tool invocation policy, got error: %s", err))
		return
	}
}

func (r *ToolInvocationPolicyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
