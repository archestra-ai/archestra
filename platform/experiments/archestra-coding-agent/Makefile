# Archestra Coding Agent Makefile
#
# Usage:
#   make build        - Build multi-arch Docker image (amd64 + arm64)
#   make build-local  - Build for local architecture only
#   make push         - Build multi-arch and push to GCP Artifact Registry
#   make run          - Run the container locally (requires GITHUB_TOKEN)
#   make test         - Run tests
#   make clean        - Remove local Docker images

# Configuration
IMAGE_REGISTRY := europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public
IMAGE_NAME := archestra-coding-agent
VERSION ?= 0.0.1
PLATFORMS := linux/amd64,linux/arm64
BUILDER_NAME := archestra-multiarch

# Full image name
FULL_IMAGE_NAME := $(IMAGE_REGISTRY)/$(IMAGE_NAME)

# Default target
.PHONY: all
all: build

# Ensure buildx builder exists
.PHONY: setup-builder
setup-builder:
	@if ! docker buildx inspect $(BUILDER_NAME) > /dev/null 2>&1; then \
		echo "Creating buildx builder '$(BUILDER_NAME)'..."; \
		docker buildx create --name $(BUILDER_NAME) --use --bootstrap; \
	else \
		docker buildx use $(BUILDER_NAME); \
	fi

# Build multi-arch Docker image (loads to local docker for testing)
# Note: Multi-arch builds can only be loaded if building for single platform
# Use 'make push' to build and push multi-arch images
.PHONY: build
build: setup-builder
	@echo "Building $(FULL_IMAGE_NAME):$(VERSION) for $(PLATFORMS)..."
	docker buildx build \
		--platform $(PLATFORMS) \
		-t $(FULL_IMAGE_NAME):$(VERSION) \
		-t $(FULL_IMAGE_NAME):latest \
		--push \
		.
	@echo "Build and push complete!"

# Build for local architecture only (faster for development)
.PHONY: build-local
build-local:
	@echo "Building $(FULL_IMAGE_NAME):$(VERSION) for local architecture..."
	docker build -t $(FULL_IMAGE_NAME):$(VERSION) .
	docker tag $(FULL_IMAGE_NAME):$(VERSION) $(FULL_IMAGE_NAME):latest
	@echo "Build complete!"

# Push to GCP Artifact Registry (multi-arch)
.PHONY: push
push: build
	@echo "Images already pushed during build (buildx --push)"

# Run the container locally
.PHONY: run
run:
ifndef GITHUB_TOKEN
	$(error GITHUB_TOKEN is required. Set it with: export GITHUB_TOKEN=your-token)
endif
	@echo "Starting Archestra Coding Agent..."
	docker run -it --rm \
		-e GITHUB_TOKEN=$(GITHUB_TOKEN) \
		-v $(PWD)/workspace:/workspace \
		-p 9121:9121 \
		$(FULL_IMAGE_NAME):$(VERSION)

# Run interactively with shell
.PHONY: shell
shell:
	@echo "Starting shell in container..."
	docker run -it --rm \
		-e GITHUB_TOKEN=$(GITHUB_TOKEN) \
		-v $(PWD)/workspace:/workspace \
		$(FULL_IMAGE_NAME):$(VERSION) \
		/bin/bash

# Run tests
.PHONY: test
test:
	@echo "Running tests..."
	pip install -r requirements.txt pytest
	PYTHONPATH=. pytest tests/ -v

# Clean up local images and builder
.PHONY: clean
clean:
	@echo "Removing local Docker images..."
	-docker rmi $(FULL_IMAGE_NAME):$(VERSION)
	-docker rmi $(FULL_IMAGE_NAME):latest
	@echo "Clean complete!"

# Remove buildx builder
.PHONY: clean-builder
clean-builder:
	@echo "Removing buildx builder..."
	-docker buildx rm $(BUILDER_NAME)
	@echo "Builder removed!"

# Show help
.PHONY: help
help:
	@echo "Archestra Coding Agent Makefile"
	@echo ""
	@echo "Usage:"
	@echo "  make build       - Build multi-arch image (amd64+arm64) and push to registry"
	@echo "  make build-local - Build for local architecture only (faster for dev)"
	@echo "  make push        - Alias for 'make build' (multi-arch build+push)"
	@echo "  make run         - Run the container locally (requires GITHUB_TOKEN)"
	@echo "  make shell       - Start an interactive shell in the container"
	@echo "  make test        - Run tests"
	@echo "  make clean       - Remove local Docker images and buildx builder"
	@echo ""
	@echo "Variables:"
	@echo "  VERSION       - Image version tag (default: 0.0.1)"
	@echo "  GITHUB_TOKEN  - GitHub personal access token (required for run)"
	@echo "  PLATFORMS     - Target platforms (default: linux/amd64,linux/arm64)"

