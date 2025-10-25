.PHONY: build install test clean generate

# Build the provider
build:
	go build -o terraform-provider-archestra

# Install the provider locally for testing
install: build
	mkdir -p ~/.terraform.d/plugins/archestra-ai/archestra/0.1.0/linux_amd64
	cp terraform-provider-archestra ~/.terraform.d/plugins/archestra-ai/archestra/0.1.0/linux_amd64/

# Run tests
test:
	go test -v ./...

# Clean build artifacts
clean:
	rm -f terraform-provider-archestra
	rm -rf dist/

# Generate API client from OpenAPI spec
generate:
	@echo "Installing oapi-codegen if not present..."
	@command -v oapi-codegen >/dev/null 2>&1 || go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest
	@echo "Generating API client..."
	oapi-codegen -config oapi-config.yaml ../shared/openapi.json
	@echo "API client generated successfully"

# Format code
fmt:
	go fmt ./...

# Run linter
lint:
	golangci-lint run
