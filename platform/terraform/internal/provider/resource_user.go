// TODO: User API endpoints are not exposed by the backend, in a way that they can be easily codegen'd
// (right now they are exposed as a single "catch-all" route, /api/auth/*, which makes codegen impossible)
// so this datasource is not yet available.
package provider

// import (
// 	"context"
// 	"fmt"

// 	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
// 	"github.com/hashicorp/terraform-plugin-framework/path"
// 	"github.com/hashicorp/terraform-plugin-framework/resource"
// 	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
// 	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
// 	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
// 	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
// 	"github.com/hashicorp/terraform-plugin-framework/types"
// )

// var _ resource.Resource = &UserResource{}
// var _ resource.ResourceWithImportState = &UserResource{}

// func NewUserResource() resource.Resource {
// 	return &UserResource{}
// }

// type UserResource struct {
// 	client *client.Client
// }

// type UserResourceModel struct {
// 	ID            types.String `tfsdk:"id"`
// 	Name          types.String `tfsdk:"name"`
// 	Email         types.String `tfsdk:"email"`
// 	EmailVerified types.Bool   `tfsdk:"email_verified"`
// 	Image         types.String `tfsdk:"image"`
// 	Role          types.String `tfsdk:"role"`
// 	Banned        types.Bool   `tfsdk:"banned"`
// 	BanReason     types.String `tfsdk:"ban_reason"`
// }

// func (r *UserResource) Metadata(ctx context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
// 	resp.TypeName = req.ProviderTypeName + "_user"
// }

// func (r *UserResource) Schema(ctx context.Context, req resource.SchemaRequest, resp *resource.SchemaResponse) {
// 	resp.Schema = schema.Schema{
// 		MarkdownDescription: "Manages an Archestra user.",

// 		Attributes: map[string]schema.Attribute{
// 			"id": schema.StringAttribute{
// 				Computed:            true,
// 				MarkdownDescription: "User identifier",
// 				PlanModifiers: []planmodifier.String{
// 					stringplanmodifier.UseStateForUnknown(),
// 				},
// 			},
// 			"name": schema.StringAttribute{
// 				MarkdownDescription: "The name of the user",
// 				Required:            true,
// 			},
// 			"email": schema.StringAttribute{
// 				MarkdownDescription: "The email address of the user",
// 				Required:            true,
// 			},
// 			"email_verified": schema.BoolAttribute{
// 				MarkdownDescription: "Whether the email is verified",
// 				Optional:            true,
// 				Computed:            true,
// 				Default:             booldefault.StaticBool(false),
// 			},
// 			"image": schema.StringAttribute{
// 				MarkdownDescription: "Profile image URL",
// 				Optional:            true,
// 			},
// 			"role": schema.StringAttribute{
// 				MarkdownDescription: "User role",
// 				Optional:            true,
// 			},
// 			"banned": schema.BoolAttribute{
// 				MarkdownDescription: "Whether the user is banned",
// 				Optional:            true,
// 				Computed:            true,
// 				Default:             booldefault.StaticBool(false),
// 			},
// 			"ban_reason": schema.StringAttribute{
// 				MarkdownDescription: "Reason for ban (if banned)",
// 				Optional:            true,
// 			},
// 		},
// 	}
// }

// func (r *UserResource) Configure(ctx context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
// 	if req.ProviderData == nil {
// 		return
// 	}

// 	client, ok := req.ProviderData.(*client.Client)
// 	if !ok {
// 		resp.Diagnostics.AddError(
// 			"Unexpected Resource Configure Type",
// 			fmt.Sprintf("Expected *client.Client, got: %T", req.ProviderData),
// 		)
// 		return
// 	}

// 	r.client = client
// }

// func (r *UserResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
// 	var data UserResourceModel
// 	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
// 	if resp.Diagnostics.HasError() {
// 		return
// 	}

// 	user := &client.User{
// 		Name:          data.Name.ValueString(),
// 		Email:         data.Email.ValueString(),
// 		EmailVerified: data.EmailVerified.ValueBool(),
// 		Banned:        data.Banned.ValueBool(),
// 	}

// 	if !data.Image.IsNull() {
// 		img := data.Image.ValueString()
// 		user.Image = &img
// 	}

// 	if !data.Role.IsNull() {
// 		role := data.Role.ValueString()
// 		user.Role = &role
// 	}

// 	if !data.BanReason.IsNull() {
// 		reason := data.BanReason.ValueString()
// 		user.BanReason = &reason
// 	}

// 	created, err := r.client.CreateUser(ctx, user)
// 	if err != nil {
// 		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to create user, got error: %s", err))
// 		return
// 	}

// 	data.ID = types.StringValue(created.ID)
// 	data.Name = types.StringValue(created.Name)
// 	data.Email = types.StringValue(created.Email)
// 	data.EmailVerified = types.BoolValue(created.EmailVerified)
// 	data.Banned = types.BoolValue(created.Banned)

// 	if created.Image != nil {
// 		data.Image = types.StringValue(*created.Image)
// 	}
// 	if created.Role != nil {
// 		data.Role = types.StringValue(*created.Role)
// 	}
// 	if created.BanReason != nil {
// 		data.BanReason = types.StringValue(*created.BanReason)
// 	}

// 	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
// }

// func (r *UserResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
// 	var data UserResourceModel
// 	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
// 	if resp.Diagnostics.HasError() {
// 		return
// 	}

// 	user, err := r.client.GetUser(ctx, data.ID.ValueString())
// 	if err != nil {
// 		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to read user, got error: %s", err))
// 		return
// 	}

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

// func (r *UserResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
// 	var data UserResourceModel
// 	resp.Diagnostics.Append(req.Plan.Get(ctx, &data)...)
// 	if resp.Diagnostics.HasError() {
// 		return
// 	}

// 	user := &client.User{
// 		Name:          data.Name.ValueString(),
// 		Email:         data.Email.ValueString(),
// 		EmailVerified: data.EmailVerified.ValueBool(),
// 		Banned:        data.Banned.ValueBool(),
// 	}

// 	if !data.Image.IsNull() {
// 		img := data.Image.ValueString()
// 		user.Image = &img
// 	}

// 	if !data.Role.IsNull() {
// 		role := data.Role.ValueString()
// 		user.Role = &role
// 	}

// 	if !data.BanReason.IsNull() {
// 		reason := data.BanReason.ValueString()
// 		user.BanReason = &reason
// 	}

// 	updated, err := r.client.UpdateUser(ctx, data.ID.ValueString(), user)
// 	if err != nil {
// 		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to update user, got error: %s", err))
// 		return
// 	}

// 	data.Name = types.StringValue(updated.Name)
// 	data.Email = types.StringValue(updated.Email)
// 	data.EmailVerified = types.BoolValue(updated.EmailVerified)
// 	data.Banned = types.BoolValue(updated.Banned)

// 	if updated.Image != nil {
// 		data.Image = types.StringValue(*updated.Image)
// 	}
// 	if updated.Role != nil {
// 		data.Role = types.StringValue(*updated.Role)
// 	}
// 	if updated.BanReason != nil {
// 		data.BanReason = types.StringValue(*updated.BanReason)
// 	}

// 	resp.Diagnostics.Append(resp.State.Set(ctx, &data)...)
// }

// func (r *UserResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
// 	var data UserResourceModel
// 	resp.Diagnostics.Append(req.State.Get(ctx, &data)...)
// 	if resp.Diagnostics.HasError() {
// 		return
// 	}

// 	err := r.client.DeleteUser(ctx, data.ID.ValueString())
// 	if err != nil {
// 		resp.Diagnostics.AddError("Client Error", fmt.Sprintf("Unable to delete user, got error: %s", err))
// 		return
// 	}
// }

// func (r *UserResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
// 	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
// }
