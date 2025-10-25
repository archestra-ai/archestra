package provider

import (
	"context"
	"fmt"

	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
	"github.com/google/uuid"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

var _ resource.Resource = &TrustedDataPolicyResource{}
var _ resource.ResourceWithImportState = &TrustedDataPolicyResource{}

func NewTrustedDataPolicyResource() resource.Resource {
	return &TrustedDataPolicyResource{}
}

type TrustedDataPolicyResource struct {
	client *client.ClientWithResponses
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

	client, ok := req.ProviderData.(*client.ClientWithResponses)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Resource Configure Type",
			fmt.Sprintf("Expected *client.ClientWithResponses, got: %T. Please report this issue to the provider developers.", req.ProviderData),
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

	// Parse AgentToolID as UUID
	parsedAgentToolID, err := uuid.Parse(data.AgentToolID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid Agent Tool ID", fmt.Sprintf("Unable to parse agent tool ID: %s", err))
		return
	}
	agentToolID := openapi_types.UUID(parsedAgentToolID)

	// Create request body using generated type
	requestBody := client.CreateTrustedDataPolicyJSONRequestBody{
		AgentToolId:   agentToolID,
		Description:   data.Description.ValueString(),
		AttributePath: data.AttributePath.ValueString(),
		Operator:      client.CreateTrustedDataPolicyJSONBodyOperator(data.Operator.ValueString()),
		Value:         data.Value.ValueString(),
		Action:        client.CreateTrustedDataPolicyJSONBodyAction(data.Action.ValueString()),
	}

	// Call API
	apiResp, err := r.client.CreateTrustedDataPolicyWithResponse(ctx, requestBody)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to create trusted data policy, got error: %s", err))
		return
	}

	// Check response
	if apiResp.JSON200 == nil {
		resp.Diagnostics.AddError(
			"Unexpected API Response",
			fmt.Sprintf("Expected 200 OK, got status %d", apiResp.StatusCode()),
		)
		return
	}

	// Map response to Terraform state
	data.ID = types.StringValue(apiResp.JSON200.Id.String())
	data.AgentToolID = types.StringValue(apiResp.JSON200.AgentToolId.String())
	data.Description = types.StringValue(apiResp.JSON200.Description)
	data.AttributePath = types.StringValue(apiResp.JSON200.AttributePath)
	data.Operator = types.StringValue(string(apiResp.JSON200.Operator))
	data.Value = types.StringValue(apiResp.JSON200.Value)
	data.Action = types.StringValue(string(apiResp.JSON200.Action))

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *TrustedDataPolicyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var data TrustedDataPolicyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Parse UUID from state
	parsedID, err := uuid.Parse(data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid ID", fmt.Sprintf("Unable to parse policy ID: %s", err))
		return
	}
	policyID := openapi_types.UUID(parsedID)

	// Call API
	apiResp, err := r.client.GetTrustedDataPolicyWithResponse(ctx, policyID)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to read trusted data policy, got error: %s", err))
		return
	}

	// Handle not found
	if apiResp.JSON404 != nil {
		resp.State.RemoveResource(ctx)
		return
	}

	// Check response
	if apiResp.JSON200 == nil {
		resp.Diagnostics.AddError(
			"Unexpected API Response",
			fmt.Sprintf("Expected 200 OK, got status %d", apiResp.StatusCode()),
		)
		return
	}

	// Map response to Terraform state
	data.AgentToolID = types.StringValue(apiResp.JSON200.AgentToolId.String())
	data.Description = types.StringValue(apiResp.JSON200.Description)
	data.AttributePath = types.StringValue(apiResp.JSON200.AttributePath)
	data.Operator = types.StringValue(string(apiResp.JSON200.Operator))
	data.Value = types.StringValue(apiResp.JSON200.Value)
	data.Action = types.StringValue(string(apiResp.JSON200.Action))

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *TrustedDataPolicyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var data TrustedDataPolicyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Parse UUIDs from state
	parsedID, err := uuid.Parse(data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid ID", fmt.Sprintf("Unable to parse policy ID: %s", err))
		return
	}
	policyID := openapi_types.UUID(parsedID)

	parsedAgentToolID, err := uuid.Parse(data.AgentToolID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid Agent Tool ID", fmt.Sprintf("Unable to parse agent tool ID: %s", err))
		return
	}
	agentToolID := openapi_types.UUID(parsedAgentToolID)

	// Create request body using generated type
	description := data.Description.ValueString()
	attributePath := data.AttributePath.ValueString()
	operator := client.UpdateTrustedDataPolicyJSONBodyOperator(data.Operator.ValueString())
	value := data.Value.ValueString()
	action := client.UpdateTrustedDataPolicyJSONBodyAction(data.Action.ValueString())

	requestBody := client.UpdateTrustedDataPolicyJSONRequestBody{
		AgentToolId:   &agentToolID,
		Description:   &description,
		AttributePath: &attributePath,
		Operator:      &operator,
		Value:         &value,
		Action:        &action,
	}

	// Call API
	apiResp, err := r.client.UpdateTrustedDataPolicyWithResponse(ctx, policyID, requestBody)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to update trusted data policy, got error: %s", err))
		return
	}

	// Check response
	if apiResp.JSON200 == nil {
		resp.Diagnostics.AddError(
			"Unexpected API Response",
			fmt.Sprintf("Expected 200 OK, got status %d", apiResp.StatusCode()),
		)
		return
	}

	// Map response to Terraform state
	data.AgentToolID = types.StringValue(apiResp.JSON200.AgentToolId.String())
	data.Description = types.StringValue(apiResp.JSON200.Description)
	data.AttributePath = types.StringValue(apiResp.JSON200.AttributePath)
	data.Operator = types.StringValue(string(apiResp.JSON200.Operator))
	data.Value = types.StringValue(apiResp.JSON200.Value)
	data.Action = types.StringValue(string(apiResp.JSON200.Action))

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *TrustedDataPolicyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var data TrustedDataPolicyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Parse UUID from state
	parsedID, err := uuid.Parse(data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid ID", fmt.Sprintf("Unable to parse policy ID: %s", err))
		return
	}
	policyID := openapi_types.UUID(parsedID)

	// Call API
	apiResp, err := r.client.DeleteTrustedDataPolicyWithResponse(ctx, policyID)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to delete trusted data policy, got error: %s", err))
		return
	}

	// Check response (200 or 404 are both acceptable for delete)
	if apiResp.JSON200 == nil && apiResp.JSON404 == nil {
		resp.Diagnostics.AddError(
			"Unexpected API Response",
			fmt.Sprintf("Expected 200 OK or 404 Not Found, got status %d", apiResp.StatusCode()),
		)
		return
	}
}

func (r *TrustedDataPolicyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
