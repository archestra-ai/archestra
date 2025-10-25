# Contributing to the Archestra Terraform Provider

Thank you for your interest in contributing to the Archestra Terraform Provider!

## Development Requirements

- [Go](https://golang.org/doc/install) >= 1.21
- [Terraform](https://www.terraform.io/downloads.html) >= 1.0
- Make (optional, for convenience)

## Building the Provider

To build the provider locally:

```bash
go build -o terraform-provider-archestra
```

Or using make:

```bash
make build
```

## Testing

Run the provider tests:

```bash
make test
```

## Local Development

To use a locally-built provider, you'll need to configure Terraform's development overrides. Create or edit `~/.terraformrc`:

```hcl
provider_installation {
  dev_overrides {
    "archestra-ai/archestra" = "/path/to/your/terraform-provider-archestra"
  }

  direct {}
}
```

Then you can run Terraform commands in the `examples/` directory.

## Generating API Client

The API client can be regenerated from the OpenAPI specification:

```bash
make generate
```

## Code Style

Run the formatter before committing:

```bash
make fmt
```

## Submitting Changes

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and formatting
5. Submit a pull request

## Release Process

Releases are automated via GitHub Actions using GoReleaser. When a new version is tagged, the provider will be built and published automatically.
