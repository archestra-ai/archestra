// TODO: User API endpoints are not exposed by the backend, in a way that they can be easily codegen'd
// (right now they are exposed as a single "catch-all" route, /api/auth/*, which makes codegen impossible)
// so this datasource is not yet available.

package provider

// import (
// 	"context"
// 	"fmt"

// 	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
// 	"github.com/hashicorp/terraform-plugin-framework/datasource"
// 	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
// 	"github.com/hashicorp/terraform-plugin-framework/types"
// )

// var _ datasource.DataSource = &UserDataSource{}

// func NewUserDataSource() datasource.DataSource {
// 	return &UserDataSource{}
// }

// type UserDataSource struct {
// 	client *client.ClientWithResponses
// }

// type UserDataSourceModel struct {
// 	ID            types.String `tfsdk:"id"`
// 	Name          types.String `tfsdk:"name"`
// 	Email         types.String `tfsdk:"email"`
// 	EmailVerified types.Bool   `tfsdk:"email_verified"`
// 	Image         types.String `tfsdk:"image"`
// 	Role          types.String `tfsdk:"role"`
// 	Banned        types.Bool   `tfsdk:"banned"`
// 	BanReason     types.String `tfsdk:"ban_reason"`
// }

// func (d *UserDataSource) Metadata(ctx context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
// 	resp.TypeName = req.ProviderTypeName + "_user"
// }

// func (d *UserDataSource) Schema(ctx context.Context, req datasource.SchemaRequest, resp *datasource.SchemaResponse) {
// 	resp.Schema = schema.Schema{
// 		MarkdownDescription: "Fetches an Archestra user by ID.",

// 		Attributes: map[string]schema.Attribute{
// 			"id": schema.StringAttribute{
// 				MarkdownDescription: "User identifier",
// 				Required:            true,
// 			},
// 			"name": schema.StringAttribute{
// 				MarkdownDescription: "The name of the user",
// 				Computed:            true,
// 			},
// 			"email": schema.StringAttribute{
// 				MarkdownDescription: "The email address of the user",
// 				Computed:            true,
// 			},
// 			"email_verified": schema.BoolAttribute{
// 				MarkdownDescription: "Whether the email is verified",
// 				Computed:            true,
// 			},
// 			"image": schema.StringAttribute{
// 				MarkdownDescription: "Profile image URL",
// 				Computed:            true,
// 			},
// 			"role": schema.StringAttribute{
// 				MarkdownDescription: "User role",
// 				Computed:            true,
// 			},
// 			"banned": schema.BoolAttribute{
// 				MarkdownDescription: "Whether the user is banned",
// 				Computed:            true,
// 			},
// 			"ban_reason": schema.StringAttribute{
// 				MarkdownDescription: "Reason for ban (if banned)",
// 				Computed:            true,
// 			},
// 		},
// 	}
// }

// func (d *UserDataSource) Configure(ctx context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
// 	if req.ProviderData == nil {
// 		return
// 	}

// 	client, ok := req.ProviderData.(*client.ClientWithResponses)
// 	if !ok {
// 		resp.Diagnostics.AddError(
// 			"Unexpected Data Source Configure Type",
// 			fmt.Sprintf("Expected *client.ClientWithResponses, got: %T", req.ProviderData),
// 		)
// 		return
// 	}

// 	d.client = client
// }

// func (d *UserDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
// 	var data UserDataSourceModel

// 	resp.Diagnostics.Append(req.Config.Get(ctx, &data)...)
// 	if resp.Diagnostics.HasError() {
// 		return
// 	}

// 	// Get user data
// 	userResp, err := d.client.GetUserWithResponse(ctx, data.ID.ValueString())
// 	if err != nil {
// 		resp.Diagnostics.AddError("API Error", fmt.Sprintf("Unable to read user, got error: %s", err))
// 		return
// 	}

// 	if userResp.JSON404 != nil {
// 		resp.Diagnostics.AddError("Not Found", fmt.Sprintf("User with ID %s not found", data.ID.ValueString()))
// 		return
// 	}

// 	if userResp.JSON200 == nil {
// 		resp.Diagnostics.AddError("Unexpected API Response", fmt.Sprintf("Expected 200 OK, got status %d", userResp.StatusCode()))
// 		return
// 	}

// 	user := userResp.JSON200
// 	data.Name = types.StringValue(user.Name)
// 	data.Email = types.StringValue(user.Email)
// 	data.EmailVerified = types.BoolValue(user.EmailVerified)
// 	data.Banned = types.BoolValue(user.Banned)

// 	if user.Image != nil {
// 		data.Image = types.StringValue(*user.Image)
// 	} else {
// 		data.Image = types.StringNull()
// 	}
// 	if user.Role != nil {
// 		data.Role = types.StringValue(*user.Role)
// 	} else {
// 		data.Role = types.StringNull()
// 	}
// 	if user.BanReason != nil {
// 		data.BanReason = types.StringValue(*user.BanReason)
// 	} else {
// 		data.BanReason = types.StringNull()
// 	}

// 	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
// }
