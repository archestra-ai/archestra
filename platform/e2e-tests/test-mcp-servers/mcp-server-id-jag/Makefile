IMAGE ?= europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-id-jag:0.0.4
PLATFORM ?= linux/amd64

.PHONY: build test publish

build:
	docker build -t $(IMAGE) .

test:
	npm test

publish:
	docker buildx build --platform $(PLATFORM) -t $(IMAGE) --push .
