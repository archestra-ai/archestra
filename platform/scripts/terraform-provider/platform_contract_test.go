package provider

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/client"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

// TestPlatformTerraformRequests checks the actual raw merge-patch requests.
// Regenerating typed clients cannot catch these: oapi-codegen represents a
// forbidden OpenAPI field (not: {}) as interface{}, which still compiles.
func TestPlatformTerraformRequests(t *testing.T) {
	doc, err := openapi3.NewLoader().LoadFromFile(os.Getenv("ARCHESTRA_TERRAFORM_OPENAPI"))
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"agent", "mcp_gateway", "catalog"} {
		for _, method := range []string{http.MethodPost, http.MethodPut} {
			t.Run(kind+"/"+method, func(t *testing.T) {
				body := platformTerraformRequest(t, kind, method)
				path := platformTerraformPath(kind)
				if method == http.MethodPut {
					path += "/{id}"
				}
				item := doc.Paths.Find(path)
				if item == nil || item.GetOperation(method) == nil {
					t.Fatalf("platform no longer exposes %s %s", method, path)
				}
				request := item.GetOperation(method).RequestBody
				if request == nil || request.Value == nil || request.Value.Content.Get("application/json") == nil {
					t.Fatalf("missing JSON request schema for %s %s", method, path)
				}
				schema := request.Value.Content.Get("application/json").Schema.Value
				if err := platformTerraformValidateRequest(schema, body); err != nil {
					t.Errorf("provider %s %s request violates platform schema: %v", method, path, err)
				}
			})
		}
	}
}

// This regression exercises the real request builders against synchronized and
// retired-field contracts. It remains useful after the provider stops emitting
// teams: the stale payload mutation must still fail validation.
func TestPlatformTerraformGuardRegression(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodPut} {
		t.Run(method, func(t *testing.T) {
			body := platformTerraformRequest(t, "agent", method)
			var allowed openapi3.Schema
			if err := json.Unmarshal([]byte(`{"type":"object","properties":{"teams":{"type":"array","items":{"type":"string"}}}}`), &allowed); err != nil {
				t.Fatal(err)
			}
			if err := allowed.VisitJSON(body); err != nil {
				t.Fatalf("synchronized request must pass: %v", err)
			}
			retired := openapi3.Schema{Type: &openapi3.Types{"object"}, Properties: openapi3.Schemas{}}
			for key := range body {
				retired.Properties[key] = &openapi3.SchemaRef{Value: &openapi3.Schema{}}
			}
			retired.Properties["teams"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
				Not: &openapi3.SchemaRef{Value: &openapi3.Schema{}},
			}}
			delete(body, "teams")
			if err := platformTerraformValidateRequest(&retired, body); err != nil {
				t.Fatalf("request without retired field must pass: %v", err)
			}
			body["teams"] = []any{}
			if err := platformTerraformValidateRequest(&retired, body); err == nil {
				t.Fatal("stale teams field must fail, including an empty list")
			}
			delete(retired.Properties, "teams")
			if err := platformTerraformValidateRequest(&retired, body); err == nil {
				t.Fatal("removed request field must fail")
			}
		})
	}
}

func platformTerraformRequest(t *testing.T, kind, method string) map[string]any {
	t.Helper()
	ctx := t.Context()
	var r resource.Resource
	if kind == "agent" {
		r = NewAgentResource()
	} else if kind == "catalog" {
		r = NewMCPServerRegistryResource()
	} else {
		r = NewMcpGatewayResource()
	}
	var schemaResponse resource.SchemaResponse
	r.Schema(ctx, resource.SchemaRequest{}, &schemaResponse)
	if schemaResponse.Diagnostics.HasError() {
		t.Fatal(schemaResponse.Diagnostics)
	}
	objectType := schemaResponse.Schema.Type().TerraformType(ctx).(tftypes.Object)
	values := map[string]tftypes.Value{}
	prior := map[string]tftypes.Value{}
	for key, typ := range objectType.AttributeTypes {
		values[key] = tftypes.NewValue(typ, nil)
		prior[key] = tftypes.NewValue(typ, nil)
	}
	values["name"] = tftypes.NewValue(tftypes.String, "contract-agent")
	// Import leaves optional fields unset; the first configured update must
	// use the real import state and omit retired sharing fields.
	if typ, exists := objectType.AttributeTypes["teams"]; exists {
		values["teams"] = tftypes.NewValue(typ, []tftypes.Value{})
	}
	id := tftypes.NewValue(tftypes.String, "00000000-0000-4000-8000-000000000001")
	values["id"] = id
	if kind == "catalog" {
		remoteType := objectType.AttributeTypes["remote_config"].(tftypes.Object)
		remote := map[string]tftypes.Value{}
		for key, typ := range remoteType.AttributeTypes {
			remote[key] = tftypes.NewValue(typ, nil)
		}
		remote["url"] = tftypes.NewValue(tftypes.String, "https://example.invalid/mcp")
		values["remote_config"] = tftypes.NewValue(remoteType, remote)
	}
	plan := tfsdk.Plan{Schema: schemaResponse.Schema, Raw: tftypes.NewValue(objectType, values)}
	state := tfsdk.State{Schema: schemaResponse.Schema, Raw: tftypes.NewValue(objectType, prior)}

	requests := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != method || !strings.HasPrefix(req.URL.Path, platformTerraformPath(kind)) {
			t.Errorf("unexpected request: %s %s", req.Method, req.URL.Path)
		}
		data, err := io.ReadAll(req.Body)
		if err != nil {
			t.Error(err)
		}
		select {
		case requests <- data:
		default:
			t.Error("unexpected additional request")
		}
		// Stop at the HTTP boundary. Response/state mapping belongs to the
		// provider's unit and acceptance suites, not this request contract.
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer server.Close()
	api, err := client.NewClientWithResponses(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	var configured resource.ConfigureResponse
	r.(resource.ResourceWithConfigure).Configure(ctx, resource.ConfigureRequest{ProviderData: api}, &configured)
	if configured.Diagnostics.HasError() {
		t.Fatal(configured.Diagnostics)
	}
	if method == http.MethodPost {
		var response resource.CreateResponse
		r.Create(ctx, resource.CreateRequest{Plan: plan}, &response)
	} else {
		var imported resource.ImportStateResponse
		imported.State = state
		r.(resource.ResourceWithImportState).ImportState(ctx,
			resource.ImportStateRequest{ID: "00000000-0000-4000-8000-000000000001"}, &imported)
		if imported.Diagnostics.HasError() {
			t.Fatal(imported.Diagnostics)
		}
		state = imported.State
		var response resource.UpdateResponse
		r.Update(ctx, resource.UpdateRequest{Plan: plan, State: state}, &response)
	}
	select {
	case data := <-requests:
		var body map[string]any
		if err := json.Unmarshal(data, &body); err != nil {
			t.Fatal(err)
		}
		if body["name"] != "contract-agent" {
			t.Fatalf("request lost configured name: %v", body)
		}
		return body
	default:
		t.Fatal("provider did not send a request")
		return nil
	}
}

func platformTerraformPath(kind string) string {
	if kind == "catalog" {
		return "/api/internal_mcp_catalog"
	}
	return "/api/agents"
}

// The pinned kin-openapi treats not: {} as empty and skips its validation.
// Check absent/forbidden top-level wire fields explicitly before value validation.
func platformTerraformFieldError(schema *openapi3.Schema, field string) error {
	property, ok := schema.Properties[field]
	if !ok || property.Value == nil {
		return fmt.Errorf("request field %q is absent from the platform schema", field)
	}
	if property.Value.Not != nil && property.Value.Not.Value != nil && property.Value.Not.Value.IsEmpty() {
		return fmt.Errorf("request field %q is forbidden by the platform schema", field)
	}
	return nil
}

func platformTerraformValidateRequest(schema *openapi3.Schema, body map[string]any) error {
	for field := range body {
		if err := platformTerraformFieldError(schema, field); err != nil {
			return err
		}
	}
	return schema.VisitJSON(body)
}

// These resources share the retired sharing fields and build raw requests from
// AttrSpecs. Check every top-level mapping, not just the lifecycle sample fields.
func TestPlatformTerraformSharingFields(t *testing.T) {
	doc, err := openapi3.NewLoader().LoadFromFile(os.Getenv("ARCHESTRA_TERRAFORM_OPENAPI"))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		constructor func() resource.Resource
		operations  []string
	}{
		{NewAgentResource, []string{"createAgent", "updateAgent"}},
		{NewMcpGatewayResource, []string{"createAgent", "updateAgent"}},
		{NewMCPServerRegistryResource, []string{"createInternalMcpCatalogItem", "updateInternalMcpCatalogItem"}},
	}
	for _, test := range cases {
		r := test.constructor()
		attrs := r.(resourceWithAttrSpec)
		var metadata resource.MetadataResponse
		r.Metadata(t.Context(), resource.MetadataRequest{ProviderTypeName: "archestra"}, &metadata)
		for _, id := range test.operations {
			t.Run(metadata.TypeName+"/"+id, func(t *testing.T) {
				var schema *openapi3.Schema
				for _, path := range doc.Paths.Map() {
					for _, operation := range path.Operations() {
						if operation.OperationID == id && operation.RequestBody != nil {
							media := operation.RequestBody.Value.Content.Get("application/json")
							if media != nil && media.Schema != nil {
								schema = media.Schema.Value
							}
						}
					}
				}
				if schema == nil {
					t.Fatalf("missing request schema for %s", id)
				}
				for _, attr := range attrs.AttrSpecs() {
					// v3 sends initialGrants only on creation; updates reconcile
					// permissions through their own endpoint.
					if attr.Kind == Synthetic || (attr.CreateOnly && strings.HasPrefix(id, "update")) {
						continue
					}
					if err := platformTerraformFieldError(schema, attr.JSONName); err != nil {
						t.Errorf("Terraform attribute %s: %v", attr.TFName, err)
					}
				}
			})
		}
	}
}
