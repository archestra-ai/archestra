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
	client *client.ClientWithResponses
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

func (r *TeamResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var data TeamResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Create request body using generated type
	requestBody := client.CreateTeamJSONRequestBody{
		Name: data.Name.ValueString(),
	}

	if !data.Description.IsNull() {
		desc := data.Description.ValueString()
		requestBody.Description = &desc
	}

	// Call API
	apiResp, err := r.client.CreateTeamWithResponse(ctx, requestBody)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to create team, got error: %s", err))
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
	data.ID = types.StringValue(apiResp.JSON200.Id)
	data.Name = types.StringValue(apiResp.JSON200.Name)
	data.OrganizationID = types.StringValue(apiResp.JSON200.OrganizationId)
	data.CreatedBy = types.StringValue(apiResp.JSON200.CreatedBy)
	if apiResp.JSON200.Description != nil {
		data.Description = types.StringValue(*apiResp.JSON200.Description)
	}

	// Add team members
	if len(data.Members) > 0 {
		for _, member := range data.Members {
			role := "member"
			if !member.Role.IsNull() {
				role = member.Role.ValueString()
			}

			memberBody := client.AddTeamMemberJSONRequestBody{
				UserId: member.UserID.ValueString(),
			}
			if role != "" {
				memberBody.Role = &role
			}

			memberResp, err := r.client.AddTeamMemberWithResponse(ctx, apiResp.JSON200.Id, memberBody)
			if err != nil {
				resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to add team member, got error: %s", err))
				return
			}
			if memberResp.JSON200 == nil {
				resp.Diagnostics.AddError(
					"Unexpected API Response",
					fmt.Sprintf("Unable to add team member, got status %d", memberResp.StatusCode()),
				)
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

	// Call API
	apiResp, err := r.client.GetTeamWithResponse(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to read team, got error: %s", err))
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
	data.OrganizationID = types.StringValue(apiResp.JSON200.OrganizationId)
	data.CreatedBy = types.StringValue(apiResp.JSON200.CreatedBy)
	if apiResp.JSON200.Description != nil {
		data.Description = types.StringValue(*apiResp.JSON200.Description)
	} else {
		data.Description = types.StringNull()
	}

	// Fetch team members
	membersResp, err := r.client.GetTeamMembersWithResponse(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to read team members, got error: %s", err))
		return
	}

	if membersResp.JSON200 == nil {
		resp.Diagnostics.AddError(
			"Unexpected API Response",
			fmt.Sprintf("Expected 200 OK for team members, got status %d", membersResp.StatusCode()),
		)
		return
	}

	data.Members = make([]TeamMemberModel, len(*membersResp.JSON200))
	for i, member := range *membersResp.JSON200 {
		data.Members[i] = TeamMemberModel{
			UserID: types.StringValue(member.UserId),
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

	// Create request body using generated type
	name := data.Name.ValueString()
	requestBody := client.UpdateTeamJSONRequestBody{
		Name: &name,
	}

	if !data.Description.IsNull() {
		desc := data.Description.ValueString()
		requestBody.Description = &desc
	}

	// Call API
	apiResp, err := r.client.UpdateTeamWithResponse(ctx, data.ID.ValueString(), requestBody)
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to update team, got error: %s", err))
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
	data.OrganizationID = types.StringValue(apiResp.JSON200.OrganizationId)
	data.CreatedBy = types.StringValue(apiResp.JSON200.CreatedBy)
	if apiResp.JSON200.Description != nil {
		data.Description = types.StringValue(*apiResp.JSON200.Description)
	}

	// Handle team member changes
	// Get current members
	membersResp, err := r.client.GetTeamMembersWithResponse(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to read current team members, got error: %s", err))
		return
	}

	if membersResp.JSON200 == nil {
		resp.Diagnostics.AddError(
			"Unexpected API Response",
			fmt.Sprintf("Expected 200 OK for team members, got status %d", membersResp.StatusCode()),
		)
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
	for _, currentMember := range *membersResp.JSON200 {
		if _, exists := desiredMembers[currentMember.UserId]; !exists {
			removeResp, err := r.client.RemoveTeamMemberWithResponse(ctx, data.ID.ValueString(), currentMember.UserId)
			if err != nil {
				resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to remove team member, got error: %s", err))
				return
			}
			if removeResp.JSON200 == nil {
				resp.Diagnostics.AddError(
					"Unexpected API Response",
					fmt.Sprintf("Unable to remove team member, got status %d", removeResp.StatusCode()),
				)
				return
			}
		}
	}

	// Add new members
	currentMemberIDs := make(map[string]bool)
	for _, member := range *membersResp.JSON200 {
		currentMemberIDs[member.UserId] = true
	}

	for userID, role := range desiredMembers {
		if !currentMemberIDs[userID] {
			memberBody := client.AddTeamMemberJSONRequestBody{
				UserId: userID,
			}
			if role != "" {
				memberBody.Role = &role
			}

			addResp, err := r.client.AddTeamMemberWithResponse(ctx, data.ID.ValueString(), memberBody)
			if err != nil {
				resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to add team member, got error: %s", err))
				return
			}
			if addResp.JSON200 == nil {
				resp.Diagnostics.AddError(
					"Unexpected API Response",
					fmt.Sprintf("Unable to add team member, got status %d", addResp.StatusCode()),
				)
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

	// Call API
	apiResp, err := r.client.DeleteTeamWithResponse(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to delete team, got error: %s", err))
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

func (r *TeamResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
