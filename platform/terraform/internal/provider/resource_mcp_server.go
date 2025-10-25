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

var _ resource.Resource = &MCPServerResource{}
var _ resource.ResourceWithImportState = &MCPServerResource{}

func NewMCPServerResource() resource.Resource {
	return &MCPServerResource{}
}

type MCPServerResource struct {
	client *client.Client
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
			},
			"catalog_id": schema.StringAttribute{
				MarkdownDescription: "The catalog ID for the MCP server",
				Optional:            true,
			},
		},
	}
}

func (r *MCPServerResource) Configure(ctx context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *MCPServerResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var data MCPServerResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	server := &client.MCPServer{
		Name: data.Name.ValueString(),
	}

	if !data.CatalogID.IsNull() {
		catalogID := data.CatalogID.ValueString()
		server.CatalogID = &catalogID
	}

	created, err := r.client.CreateMCPServer(ctx, server)
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to create MCP server, got error: %s", err))
		return
	}

	data.ID = types.StringValue(created.ID)
	data.Name = types.StringValue(created.Name)
	if created.CatalogID != nil {
		data.CatalogID = types.StringValue(*created.CatalogID)
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *MCPServerResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var data MCPServerResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	server, err := r.client.GetMCPServer(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to read MCP server, got error: %s", err))
		return
	}

	data.Name = types.StringValue(server.Name)
	if server.CatalogID != nil {
		data.CatalogID = types.StringValue(*server.CatalogID)
	} else {
		data.CatalogID = types.StringNull()
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *MCPServerResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var data MCPServerResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	server := &client.MCPServer{
		Name: data.Name.ValueString(),
	}

	if !data.CatalogID.IsNull() {
		catalogID := data.CatalogID.ValueString()
		server.CatalogID = &catalogID
	}

	updated, err := r.client.UpdateMCPServer(ctx, data.ID.ValueString(), server)
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to update MCP server, got error: %s", err))
		return
	}

	data.Name = types.StringValue(updated.Name)
	if updated.CatalogID != nil {
		data.CatalogID = types.StringValue(*updated.CatalogID)
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *MCPServerResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var data MCPServerResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeleteMCPServer(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to delete MCP server, got error: %s", err))
		return
	}
}

func (r *MCPServerResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
