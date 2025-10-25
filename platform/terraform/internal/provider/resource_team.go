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

var _ resource.Resource = &TeamResource{}
var _ resource.ResourceWithImportState = &TeamResource{}

func NewTeamResource() resource.Resource {
	return &TeamResource{}
}

type TeamResource struct {
	client *client.Client
}

type TeamMemberModel struct {
	UserID types.String `tfsdk:"user_id"`
	Role   types.String `tfsdk:"role"`
}

type TeamResourceModel struct {
	ID             types.String      `tfsdk:"id"`
	Name           types.String      `tfsdk:"name"`
	Description    types.String      `tfsdk:"description"`
	OrganizationID types.String      `tfsdk:"organization_id"`
	CreatedBy      types.String      `tfsdk:"created_by"`
	Members        []TeamMemberModel `tfsdk:"members"`
}

func (r *TeamResource) Metadata(ctx context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_team"
}

func (r *TeamResource) Schema(ctx context.Context, req resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manages an Archestra team with members.",

		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Team identifier",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"name": schema.StringAttribute{
				MarkdownDescription: "The name of the team",
				Required:            true,
			},
			"description": schema.StringAttribute{
				MarkdownDescription: "Description of the team",
				Optional:            true,
			},
			"organization_id": schema.StringAttribute{
				MarkdownDescription: "The organization ID this team belongs to",
				Required:            true,
			},
			"created_by": schema.StringAttribute{
				MarkdownDescription: "User ID of the team creator",
				Required:            true,
			},
			"members": schema.ListNestedAttribute{
				MarkdownDescription: "List of team members",
				Optional:            true,
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"user_id": schema.StringAttribute{
							MarkdownDescription: "User ID of the team member",
							Required:            true,
						},
						"role": schema.StringAttribute{
							MarkdownDescription: "Role of the team member (default: member)",
							Optional:            true,
							Computed:            true,
							Default:             stringdefault.StaticString("member"),
						},
					},
				},
			},
		},
	}
}

func (r *TeamResource) Configure(ctx context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *TeamResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var data TeamResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	team := &client.Team{
		Name:           data.Name.ValueString(),
		OrganizationID: data.OrganizationID.ValueString(),
		CreatedBy:      data.CreatedBy.ValueString(),
	}

	if !data.Description.IsNull() {
		desc := data.Description.ValueString()
		team.Description = &desc
	}

	created, err := r.client.CreateTeam(ctx, team)
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to create team, got error: %s", err))
		return
	}

	data.ID = types.StringValue(created.ID)
	data.Name = types.StringValue(created.Name)
	data.OrganizationID = types.StringValue(created.OrganizationID)
	data.CreatedBy = types.StringValue(created.CreatedBy)
	if created.Description != nil {
		data.Description = types.StringValue(*created.Description)
	}

	// Add team members
	if len(data.Members) > 0 {
		for _, member := range data.Members {
			role := "member"
			if !member.Role.IsNull() {
				role = member.Role.ValueString()
			}

			_, err := r.client.AddTeamMember(ctx, created.ID, member.UserID.ValueString(), role)
			if err != nil {
				resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to add team member, got error: %s", err))
				return
			}
		}
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *TeamResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var data TeamResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	team, err := r.client.GetTeam(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to read team, got error: %s", err))
		return
	}

	data.Name = types.StringValue(team.Name)
	data.OrganizationID = types.StringValue(team.OrganizationID)
	data.CreatedBy = types.StringValue(team.CreatedBy)
	if team.Description != nil {
		data.Description = types.StringValue(*team.Description)
	} else {
		data.Description = types.StringNull()
	}

	// Fetch team members
	members, err := r.client.GetTeamMembers(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to read team members, got error: %s", err))
		return
	}

	data.Members = make([]TeamMemberModel, len(members))
	for i, member := range members {
		data.Members[i] = TeamMemberModel{
			UserID: types.StringValue(member.UserID),
			Role:   types.StringValue(member.Role),
		}
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *TeamResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var data TeamResourceModel
	var state TeamResourceModel

	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	team := &client.Team{
		Name:           data.Name.ValueString(),
		OrganizationID: data.OrganizationID.ValueString(),
		CreatedBy:      data.CreatedBy.ValueString(),
	}

	if !data.Description.IsNull() {
		desc := data.Description.ValueString()
		team.Description = &desc
	}

	updated, err := r.client.UpdateTeam(ctx, data.ID.ValueString(), team)
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to update team, got error: %s", err))
		return
	}

	data.Name = types.StringValue(updated.Name)
	data.OrganizationID = types.StringValue(updated.OrganizationID)
	data.CreatedBy = types.StringValue(updated.CreatedBy)
	if updated.Description != nil {
		data.Description = types.StringValue(*updated.Description)
	}

	// Handle team member changes
	// Get current members
	currentMembers, err := r.client.GetTeamMembers(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to read current team members, got error: %s", err))
		return
	}

	// Create a map of desired members
	desiredMembers := make(map[string]string) // userID -> role
	for _, member := range data.Members {
		role := "member"
		if !member.Role.IsNull() {
			role = member.Role.ValueString()
		}
		desiredMembers[member.UserID.ValueString()] = role
	}

	// Remove members not in desired state
	for _, currentMember := range currentMembers {
		if _, exists := desiredMembers[currentMember.UserID]; !exists {
			err := r.client.RemoveTeamMember(ctx, data.ID.ValueString(), currentMember.ID)
			if err != nil {
				resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to remove team member, got error: %s", err))
				return
			}
		}
	}

	// Add new members
	currentMemberIDs := make(map[string]bool)
	for _, member := range currentMembers {
		currentMemberIDs[member.UserID] = true
	}

	for userID, role := range desiredMembers {
		if !currentMemberIDs[userID] {
			_, err := r.client.AddTeamMember(ctx, data.ID.ValueString(), userID, role)
			if err != nil {
				resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to add team member, got error: %s", err))
				return
			}
		}
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
}

func (r *TeamResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var data TeamResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeleteTeam(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to delete team, got error: %s", err))
		return
	}
}

func (r *TeamResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
