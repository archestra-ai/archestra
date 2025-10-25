package main

import (
	"context"
	"flag"
	"log"

	"github.com/archestra-ai/archestra/terraform-provider-archestra/internal/provider"
	"github.com/hashicorp/terraform-plugin-framework/providerserver"
)

// Generate the Terraform provider documentation using tfplugindocs:
//
//go:generate go run github.com/hashicorp/terraform-plugin-docs/cmd/tfplugindocs

var (
	// these will be set by the goreleaser configuration
	// to appropriate values for the compiled binary
	version string = "dev"
)

func main() {
	var debug bool

	flag.BoolVar(&debug, "debug", false, "set to true to run the provider with support for debuggers like delve")
	flag.Parse()

	opts := providerserver.ServeOpts{
		Address: "registry.terraform.io/archestra-ai/archestra",
		Debug:   debug,
	}

	err := providerserver.Serve(context.Background(), provider.New(version), opts)

	if err != nil {
		log.Fatal(err.Error())
	}
}
