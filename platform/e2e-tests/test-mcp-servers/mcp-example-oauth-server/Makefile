IMAGE_REGISTRY := europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public
IMAGE_NAME := mcp-example-oauth-server
IMAGE_TAG := 0.0.1
FULL_IMAGE := $(IMAGE_REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)

.PHONY: build push build-and-push

## Build multi-arch Docker image
build:
	docker buildx build \
		--platform linux/amd64,linux/arm64 \
		-t $(FULL_IMAGE) \
		.

## Build and push multi-arch Docker image to GAR
push:
	docker buildx build \
		--platform linux/amd64,linux/arm64 \
		-t $(FULL_IMAGE) \
		--push \
		.

## Build locally (current arch only, for testing)
build-local:
	docker build -t $(IMAGE_NAME):$(IMAGE_TAG) .
