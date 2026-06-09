IMAGE ?= europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-network-probe:0.0.1
PLATFORM ?= linux/amd64,linux/arm64
BUILDER ?= archestra-multiarch

.PHONY: build build-local push configure-docker

build:
	docker buildx build --builder $(BUILDER) --platform $(PLATFORM) -t $(IMAGE) .

build-local:
	docker build -t $(IMAGE) .

configure-docker:
	gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet

push: configure-docker
	docker buildx inspect $(BUILDER) >/dev/null 2>&1 || docker buildx create --name $(BUILDER) --driver docker-container --use
	docker buildx inspect --bootstrap $(BUILDER)
	docker buildx build --builder $(BUILDER) --platform $(PLATFORM) -t $(IMAGE) --push .
