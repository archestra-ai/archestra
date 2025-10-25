package provider

import (
	"context"
	"fmt"

	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var _ resource.Resource = &TrustedDataPolicyResource{}
var _ resource.ResourceWithImportState = &TrustedDataPolicyResource{}

func NewTrustedDataPolicyResource() resource.Resource {
	return &TrustedDataPolicyResource{}
}

type TrustedDataPolicyResource struct {
	client *client.Client
}

type TrustedDataPolicyResourceModel struct {
	ID            types.String `tfsdk:"id"`
	AgentToolID   types.String `tfsdk:"agent_tool_id"`
	Description   types.String `tfsdk:"description"`
	AttributePath types.String `tfsdk:"attribute_path"`
	Operator      types.String `tfsdk:"operator"`
	Value         types.String `tfsdk:"value"`
	Action        types.String `tfsdk:"action"`
}

func (r *TrustedDataPolicyResource) Metadata(ctx context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_trusted_data_policy"
}

func (r *TrustedDataPolicyResource) Schema(ctx context.Context, req resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manages an Archestra trusted data policy.",

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
			"description": schema.StringAttribute{
				MarkdownDescription: "Description of the policy",
				Required:            true,
			},
			"attribute_path": schema.StringAttribute{
				MarkdownDescription: "The attribute path to match",
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
				MarkdownDescription: "The action to take (default: mark_as_trusted)",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("mark_as_trusted"),
			},
		},
	}
}

func (r *TrustedDataPolicyResource) Configure(ctx context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *TrustedDataPolicyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var data TrustedDataPolicyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	policy := &client.TrustedDataPolicy{
		AgentToolID:   data.AgentToolID.ValueString(),
		Description:   data.Description.ValueString(),
		AttributePath: data.AttributePath.ValueString(),
		Operator:      data.Operator.ValueString(),
		Value:         data.Value.ValueString(),
		Action:        data.Action.ValueString(),
	}

	created, err := r.client.CreateTrustedDataPolicy(ctx, policy)
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to create trusted data policy, got error: %s", err))
		return
	}

	data.ID = types.StringValue(created.ID)
	data.AgentToolID = types.StringValue(created.AgentToolID)
	data.Description = types.StringValue(created.Description)
	data.AttributePath = types.StringValue(created.AttributePath)
	data.Operator = types.StringValue(created.Operator)
	data.Value = types.StringValue(created.Value)
	data.Action = types.StringValue(created.Action)

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *TrustedDataPolicyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var data TrustedDataPolicyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	policy, err := r.client.GetTrustedDataPolicy(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to read trusted data policy, got error: %s", err))
		return
	}

	data.AgentToolID = types.StringValue(policy.AgentToolID)
	data.Description = types.StringValue(policy.Description)
	data.AttributePath = types.StringValue(policy.AttributePath)
	data.Operator = types.StringValue(policy.Operator)
	data.Value = types.StringValue(policy.Value)
	data.Action = types.StringValue(policy.Action)

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *TrustedDataPolicyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var data TrustedDataPolicyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	policy := &client.TrustedDataPolicy{
		AgentToolID:   data.AgentToolID.ValueString(),
		Description:   data.Description.ValueString(),
		AttributePath: data.AttributePath.ValueString(),
		Operator:      data.Operator.ValueString(),
		Value:         data.Value.ValueString(),
		Action:        data.Action.ValueString(),
	}

	updated, err := r.client.UpdateTrustedDataPolicy(ctx, data.ID.ValueString(), policy)
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to update trusted data policy, got error: %s", err))
		return
	}

	data.AgentToolID = types.StringValue(updated.AgentToolID)
	data.Description = types.StringValue(updated.Description)
	data.AttributePath = types.StringValue(updated.AttributePath)
	data.Operator = types.StringValue(updated.Operator)
	data.Value = types.StringValue(updated.Value)
	data.Action = types.StringValue(updated.Action)

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *TrustedDataPolicyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var data TrustedDataPolicyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeleteTrustedDataPolicy(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to delete trusted data policy, got error: %s", err))
		return
	}
}

func (r *TrustedDataPolicyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
