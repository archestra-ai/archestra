package provider

import (
	"context"
	"fmt"

	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
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
	client *client.Client
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

	client, ok := req.ProviderData.(*client.Client)

	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Resource Configure Type",
			fmt.Sprintf("Expected *client.Client, got: %T. Please report this issue to the provider developers.", req.ProviderData),
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

	agent := &client.Agent{
		Name:      data.Name.ValueString(),
		IsDemo:    data.IsDemo.ValueBool(),
		IsDefault: data.IsDefault.ValueBool(),
	}

	created, err := r.client.CreateAgent(ctx, agent)
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to create agent, got error: %s", err))
		return
	}

	data.ID = types.StringValue(created.ID)
	data.Name = types.StringValue(created.Name)
	data.IsDemo = types.BoolValue(created.IsDemo)
	data.IsDefault = types.BoolValue(created.IsDefault)

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *AgentResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var data AgentResourceModel

	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)

	if resp.Diagnostics.HasError() {
		return
	}

	agent, err := r.client.GetAgent(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to read agent, got error: %s", err))
		return
	}

	data.Name = types.StringValue(agent.Name)
	data.IsDemo = types.BoolValue(agent.IsDemo)
	data.IsDefault = types.BoolValue(agent.IsDefault)

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *AgentResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var data AgentResourceModel

	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)

	if resp.Diagnostics.HasError() {
		return
	}

	agent := &client.Agent{
		Name:      data.Name.ValueString(),
		IsDemo:    data.IsDemo.ValueBool(),
		IsDefault: data.IsDefault.ValueBool(),
	}

	updated, err := r.client.UpdateAgent(ctx, data.ID.ValueString(), agent)
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to update agent, got error: %s", err))
		return
	}

	data.Name = types.StringValue(updated.Name)
	data.IsDemo = types.BoolValue(updated.IsDemo)
	data.IsDefault = types.BoolValue(updated.IsDefault)

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *AgentResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var data AgentResourceModel

	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)

	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeleteAgent(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to delete agent, got error: %s", err))
		return
	}
}

func (r *AgentResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
