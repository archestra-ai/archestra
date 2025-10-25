package provider

import (
	"context"
	"fmt"

	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var _ datasource.DataSource = &TeamDataSource{}

func NewTeamDataSource() datasource.DataSource {
	return &TeamDataSource{}
}

type TeamDataSource struct {
	client *client.ClientWithResponses
}

type TeamDataSourceModel struct {
	ID             types.String      `tfsdk:"id"`
	Name           types.String      `tfsdk:"name"`
	Description    types.String      `tfsdk:"description"`
	OrganizationID types.String      `tfsdk:"organization_id"`
	CreatedBy      types.String      `tfsdk:"created_by"`
	Members        []TeamMemberModel `tfsdk:"members"`
}

func (d *TeamDataSource) Metadata(ctx context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_team"
}

func (d *TeamDataSource) Schema(ctx context.Context, req datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Fetches an Archestra team by ID.",

		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				MarkdownDescription: "Team identifier",
				Required:            true,
			},
			"name": schema.StringAttribute{
				MarkdownDescription: "The name of the team",
				Computed:            true,
			},
			"description": schema.StringAttribute{
				MarkdownDescription: "Description of the team",
				Computed:            true,
			},
			"organization_id": schema.StringAttribute{
				MarkdownDescription: "The organization ID this team belongs to",
				Computed:            true,
			},
			"created_by": schema.StringAttribute{
				MarkdownDescription: "User ID of the team creator",
				Computed:            true,
			},
			"members": schema.ListNestedAttribute{
				MarkdownDescription: "List of team members",
				Computed:            true,
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"user_id": schema.StringAttribute{
							MarkdownDescription: "User ID of the team member",
							Computed:            true,
						},
						"role": schema.StringAttribute{
							MarkdownDescription: "Role of the team member",
							Computed:            true,
						},
					},
				},
			},
		},
	}
}

func (d *TeamDataSource) Configure(ctx context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}

	client, ok := req.ProviderData.(*client.ClientWithResponses)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Data Source Configure Type",
			fmt.Sprintf("Expected *client.ClientWithResponses, got: %T", req.ProviderData),
		)
		return
	}

	d.client = client
}

func (d *TeamDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var data TeamDataSourceModel

	resp.Diagnostics.Append(req.Config.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Get team data
	teamResp, err := d.client.GetTeamWithResponse(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to read team, got error: %s", err))
		return
	}

	if teamResp.JSON404 != nil {
		resp.Diagnostics.AddError("Not Found", fmt.Sprintf("Team with ID %s not found", data.ID.ValueString()))
		return
	}

	if teamResp.JSON200 == nil {
		resp.Diagnostics.AddError("Unexpected API Response", fmt.Sprintf("Expected 200 OK, got status %d", teamResp.StatusCode()))
		return
	}

	team := teamResp.JSON200
	data.Name = types.StringValue(team.Name)
	data.OrganizationID = types.StringValue(team.OrganizationId)
	data.CreatedBy = types.StringValue(team.CreatedBy)
	if team.Description != nil {
		data.Description = types.StringValue(*team.Description)
	} else {
		data.Description = types.StringNull()
	}

	// Fetch team members
	membersResp, err := d.client.GetTeamMembersWithResponse(ctx, data.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to read team members, got error: %s", err))
		return
	}

	if membersResp.JSON200 == nil {
		resp.Diagnostics.AddError("Unexpected API Response", fmt.Sprintf("Expected 200 OK, got status %d", membersResp.StatusCode()))
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
