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
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

var _ resource.Resource = &MCPServerResource{}
var _ resource.ResourceWithImportState = &MCPServerResource{}

func NewMCPServerResource() resource.Resource {
	return &MCPServerResource{}
}

type MCPServerResource struct {
	client *client.ClientWithResponses
}

type MCPServerResourceModel struct {
	ID        types.String `tfsdk:"id"`
	Name      types.String `tfsdk:"name"`
	CatalogID types.String `tfsdk:"catalog_id"`
}

func (r *MCPServerResource) Metadata(ctx context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_mcp_server_installation"
}

func (r *MCPServerResource) Schema(ctx context.Context, req resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manages an Archestra MCP server installation.",

		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "MCP server identifier",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"name": schema.StringAttribute{
				MarkdownDescription: "The name of the MCP server",
				Required:            true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"catalog_id": schema.StringAttribute{
				MarkdownDescription: "The catalog ID for the MCP server",
				Optional:            true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
		},
	}
}

func (r *MCPServerResource) Configure(ctx context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *MCPServerResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var data MCPServerResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Create request body using generated type
	requestBody := client.InstallMcpServerJSONRequestBody{
		Name: data.Name.ValueString(),
	}

	if !data.CatalogID.IsNull() {
		catalogID, err := uuid.Parse(data.CatalogID.ValueString())
		if err != nil {
			resp.Diagnostics.AddError("Invalid Catalog ID", fmt.Sprintf("Unable to parse catalog ID: %s", err))
			return
		}
		catalogUUID := openapi_types.UUID(catalogID)
		requestBody.CatalogId = &catalogUUID
	}

	// Call API
	apiResp, err := r.client.InstallMcpServerWithResponse(ctx, requestBody)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to install MCP server, got error: %s", err))
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
	if apiResp.JSON200.CatalogId != nil {
		data.CatalogID = types.StringValue(apiResp.JSON200.CatalogId.String())
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *MCPServerResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var data MCPServerResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Parse UUID from state
	parsedID, err := uuid.Parse(data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid ID", fmt.Sprintf("Unable to parse MCP server ID: %s", err))
		return
	}
	serverID := openapi_types.UUID(parsedID)

	// Call API
	apiResp, err := r.client.GetMcpServerWithResponse(ctx, serverID)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to read MCP server, got error: %s", err))
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
	if apiResp.JSON200.CatalogId != nil {
		data.CatalogID = types.StringValue(apiResp.JSON200.CatalogId.String())
	} else {
		data.CatalogID = types.StringNull()
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *MCPServerResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	// NOTE: The Archestra API does not support updating MCP servers.
	// Updates will trigger resource replacement (delete + create).
	// This function should never be called due to RequiresReplace plan modifiers on all attributes.
	resp.Diagnostics.AddError(
		"Update Not Supported",
		"MCP server updates are not supported by the API. This should have triggered a replacement.",
	)
}

func (r *MCPServerResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var data MCPServerResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Parse UUID from state
	parsedID, err := uuid.Parse(data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid ID", fmt.Sprintf("Unable to parse MCP server ID: %s", err))
		return
	}
	serverID := openapi_types.UUID(parsedID)

	// Call API
	apiResp, err := r.client.DeleteMcpServerWithResponse(ctx, serverID)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to delete MCP server, got error: %s", err))
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

func (r *MCPServerResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
