# Archestra Coding Agent Makefile
#
# Usage:
#   make build        - Build the Docker image locally
#   make push         - Build and push to GCP Artifact Registry
#   make run          - Run the container locally (requires GITHUB_TOKEN)
#   make test         - Run tests
#   make clean        - Remove local Docker images

# Configuration
IMAGE_REGISTRY := europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public
IMAGE_NAME := archestra-coding-agent
VERSION ?= 0.0.1

# Full image name
FULL_IMAGE_NAME := $(IMAGE_REGISTRY)/$(IMAGE_NAME)

# Default target
.PHONY: all
all: build

# Build the Docker image
.PHONY: build
build:
	@echo "Building $(FULL_IMAGE_NAME):$(VERSION)..."
	docker build -t $(FULL_IMAGE_NAME):$(VERSION) .
	docker tag $(FULL_IMAGE_NAME):$(VERSION) $(FULL_IMAGE_NAME):latest
	@echo "Build complete!"

# Push to GCP Artifact Registry
.PHONY: push
push: build
	@echo "Pushing $(FULL_IMAGE_NAME):$(VERSION) to registry..."
	docker push $(FULL_IMAGE_NAME):$(VERSION)
	docker push $(FULL_IMAGE_NAME):latest
	@echo "Push complete!"

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

# Clean up local images
.PHONY: clean
clean:
	@echo "Removing local Docker images..."
	-docker rmi $(FULL_IMAGE_NAME):$(VERSION)
	-docker rmi $(FULL_IMAGE_NAME):latest
	@echo "Clean complete!"

# Show help
.PHONY: help
help:
	@echo "Archestra Coding Agent Makefile"
	@echo ""
	@echo "Usage:"
	@echo "  make build    - Build the Docker image locally"
	@echo "  make push     - Build and push to GCP Artifact Registry"
	@echo "  make run      - Run the container locally (requires GITHUB_TOKEN)"
	@echo "  make shell    - Start an interactive shell in the container"
	@echo "  make test     - Run tests"
	@echo "  make clean    - Remove local Docker images"
	@echo ""
	@echo "Variables:"
	@echo "  VERSION       - Image version tag (default: 0.0.1)"
	@echo "  GITHUB_TOKEN  - GitHub personal access token (required for run)"

