IMAGE ?= europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-jwks-keycloak:0.0.3
PLATFORMS ?= linux/amd64,linux/arm64
BUILDER ?= archestra-multiarch

.PHONY: prepare-builder build publish

prepare-builder:
	docker buildx inspect $(BUILDER) >/dev/null 2>&1 || docker buildx create --name $(BUILDER) --driver docker-container --use
	docker buildx inspect --bootstrap $(BUILDER)

build: prepare-builder
	docker buildx build \
		--builder $(BUILDER) \
		--platform $(PLATFORMS) \
		--tag $(IMAGE) \
		.

publish: prepare-builder
	gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet
	docker buildx build \
		--builder $(BUILDER) \
		--platform $(PLATFORMS) \
		--tag $(IMAGE) \
		--push \
		.
