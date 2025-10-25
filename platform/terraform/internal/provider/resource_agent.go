package provider

import (
	"context"
	"fmt"

	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
	"github.com/google/uuid"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// Ensure provider defined types fully satisfy framework interfaces.
var _ resource.Resource = &AgentResource{}
var _ resource.ResourceWithImportState = &AgentResource{}

func NewAgentResource() resource.Resource {
	return &AgentResource{}
}

// AgentResource defines the resource implementation.
type AgentResource struct {
	client *client.ClientWithResponses
}

// AgentResourceModel describes the resource data model.
type AgentResourceModel struct {
	ID        types.String `tfsdk:"id"`
	Name      types.String `tfsdk:"name"`
	IsDemo    types.Bool   `tfsdk:"is_demo"`
	IsDefault types.Bool   `tfsdk:"is_default"`
}

func (r *AgentResource) Metadata(ctx context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_agent"
}

func (r *AgentResource) Schema(ctx context.Context, req resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manages an Archestra agent.",

		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Agent identifier",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"name": schema.StringAttribute{
				MarkdownDescription: "The name of the agent",
				Required:            true,
			},
			"is_demo": schema.BoolAttribute{
				MarkdownDescription: "Whether this is a demo agent",
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(false),
			},
			"is_default": schema.BoolAttribute{
				MarkdownDescription: "Whether this is the default agent",
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(false),
			},
		},
	}
}

func (r *AgentResource) Configure(ctx context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *AgentResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var data AgentResourceModel

	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)

	if resp.Diagnostics.HasError() {
		return
	}

	// Create request body using generated type
	requestBody := client.CreateAgentJSONRequestBody{
		Name:  data.Name.ValueString(),
		Teams: []string{}, // Empty teams array (required by API)
	}

	// Set optional fields if provided
	if !data.IsDemo.IsNull() {
		isDemo := data.IsDemo.ValueBool()
		requestBody.IsDemo = &isDemo
	}
	if !data.IsDefault.IsNull() {
		isDefault := data.IsDefault.ValueBool()
		requestBody.IsDefault = &isDefault
	}

	// Call API
	apiResp, err := r.client.CreateAgentWithResponse(ctx, requestBody)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to create agent, got error: %s", err))
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
	data.Name = types.StringValue(apiResp.JSON200.Name)
	data.IsDemo = types.BoolValue(apiResp.JSON200.IsDemo)
	data.IsDefault = types.BoolValue(apiResp.JSON200.IsDefault)

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *AgentResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var data AgentResourceModel

	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)

	if resp.Diagnostics.HasError() {
		return
	}

	// Parse UUID from state
	agentID, err := uuid.Parse(data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid ID", fmt.Sprintf("Unable to parse agent ID: %s", err))
		return
	}

	// Call API
	apiResp, err := r.client.GetAgentWithResponse(ctx, agentID)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to read agent, got error: %s", err))
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
	data.Name = types.StringValue(apiResp.JSON200.Name)
	data.IsDemo = types.BoolValue(apiResp.JSON200.IsDemo)
	data.IsDefault = types.BoolValue(apiResp.JSON200.IsDefault)

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *AgentResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var data AgentResourceModel

	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)

	if resp.Diagnostics.HasError() {
		return
	}

	// Parse UUID from state
	agentID, err := uuid.Parse(data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid ID", fmt.Sprintf("Unable to parse agent ID: %s", err))
		return
	}

	// Create request body using generated type
	name := data.Name.ValueString()
	requestBody := client.UpdateAgentJSONRequestBody{
		Name: &name,
	}

	// Set optional fields if provided
	if !data.IsDemo.IsNull() {
		isDemo := data.IsDemo.ValueBool()
		requestBody.IsDemo = &isDemo
	}
	if !data.IsDefault.IsNull() {
		isDefault := data.IsDefault.ValueBool()
		requestBody.IsDefault = &isDefault
	}

	// Call API
	apiResp, err := r.client.UpdateAgentWithResponse(ctx, agentID, requestBody)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to update agent, got error: %s", err))
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
	data.Name = types.StringValue(apiResp.JSON200.Name)
	data.IsDemo = types.BoolValue(apiResp.JSON200.IsDemo)
	data.IsDefault = types.BoolValue(apiResp.JSON200.IsDefault)

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *AgentResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var data AgentResourceModel

	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)

	if resp.Diagnostics.HasError() {
		return
	}

	// Parse UUID from state
	agentID, err := uuid.Parse(data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid ID", fmt.Sprintf("Unable to parse agent ID: %s", err))
		return
	}

	// Call API
	apiResp, err := r.client.DeleteAgentWithResponse(ctx, agentID)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to delete agent, got error: %s", err))
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

func (r *AgentResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
