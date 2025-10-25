package provider

import (
	"context"
	"net/http"

	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// Ensure provider defined types fully satisfy framework interfaces.
var _ provider.Provider = &ArchestraProvider{}

// ArchestraProvider defines the provider implementation.
type ArchestraProvider struct {
	// version is set to the provider version on release, "dev" when the
	// provider is built and ran locally, and "test" when running acceptance
	// testing.
	version string
}

// ArchestraProviderModel describes the provider data model.
type ArchestraProviderModel struct {
	BaseURL types.String `tfsdk:"base_url"`
	APIKey  types.String `tfsdk:"api_key"`
}

func (p *ArchestraProvider) Metadata(ctx context.Context, req provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "archestra"
	resp.Version = p.version
}

func (p *ArchestraProvider) Schema(ctx context.Context, req provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The Archestra provider is used to interact with Archestra resources. " +
			"The provider needs to be configured with the proper credentials before it can be used.",
		Attributes: map[string]schema.Attribute{
			"base_url": schema.StringAttribute{
				MarkdownDescription: "The base URL for the Archestra API. May also be provided via the ARCHESTRA_BASE_URL environment variable.",
				Optional:            true,
			},
			"api_key": schema.StringAttribute{
				MarkdownDescription: "The API key for authentication. May also be provided via the ARCHESTRA_API_KEY environment variable.",
				Optional:            true,
				Sensitive:           true,
			},
		},
	}
}

func (p *ArchestraProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var config ArchestraProviderModel

	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)

	if resp.Diagnostics.HasError() {
		return
	}

	// Configuration values are now available.
	baseURL := config.BaseURL.ValueString()
	apiKey := config.APIKey.ValueString()

	// If practitioner provided a configuration value for any of the
	// attributes, it must be a known value.

	if config.BaseURL.IsUnknown() {
		resp.Diagnostics.AddAttributeError(
			path.Root("base_url"),
			"Unknown Archestra API Base URL",
			"The provider cannot create the Archestra API client as there is an unknown configuration value for the Archestra API base URL. "+
				"Either target apply the source of the value first, set the value statically in the configuration, or use the ARCHESTRA_BASE_URL environment variable.",
		)
	}

	if config.APIKey.IsUnknown() {
		resp.Diagnostics.AddAttributeError(
			path.Root("api_key"),
			"Unknown Archestra API Key",
			"The provider cannot create the Archestra API client as there is an unknown configuration value for the Archestra API key. "+
				"Either target apply the source of the value first, set the value statically in the configuration, or use the ARCHESTRA_API_KEY environment variable.",
		)
	}

	if resp.Diagnostics.HasError() {
		return
	}

	// Default values to environment variables, but override
	// with Terraform configuration value if set.

	if baseURL == "" {
		baseURL = "http://localhost:9000"
	}

	if apiKey == "" {
		resp.Diagnostics.AddAttributeError(
			path.Root("api_key"),
			"Missing Archestra API Key",
			"The provider cannot create the Archestra API client as there is a missing or empty value for the Archestra API key. "+
				"Set the api_key value in the configuration or use the ARCHESTRA_API_KEY environment variable. "+
				"If either is already set, ensure the value is not empty.",
		)
	}

	if resp.Diagnostics.HasError() {
		return
	}

	// Create a new Archestra client using the configuration values
	apiClient, err := client.NewClientWithResponses(
		baseURL,
		client.WithRequestEditorFn(func(ctx context.Context, req *http.Request) error {
			// Add API key as Bearer token to all requests
			req.Header.Set("Authorization", "Bearer "+apiKey)
			return nil
		}),
	)

	if err != nil {
		resp.Diagnostics.AddError(
			"Unable to Create Archestra API Client",
			"An unexpected error occurred when creating the Archestra API client. "+
				"If the error is not clear, please contact the provider developers.\n\n"+
				"Archestra Client Error: "+err.Error(),
		)
		return
	}

	// Make the Archestra client available during DataSource and Resource
	// type Configure methods.
	resp.DataSourceData = apiClient
	resp.ResourceData = apiClient
}

func (p *ArchestraProvider) Resources(ctx context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewAgentResource,
		NewMCPServerResource,
		NewTrustedDataPolicyResource,
		NewToolInvocationPolicyResource,
		NewTeamResource,
		// NewUserResource, // TODO: Enable when user API endpoints are implemented
	}
}

func (p *ArchestraProvider) DataSources(ctx context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		NewTeamDataSource,
		// NewUserDataSource, // TODO: Enable when user API endpoints are implemented
		NewAgentToolDataSource,
		NewMCPServerToolDataSource,
	}
}

func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &ArchestraProvider{
			version: version,
		}
	}
}
