IMAGE ?= europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-id-jag:0.0.1

.PHONY: build test publish

build:
	docker build -t $(IMAGE) .

test:
	npm test

publish: build
	docker push $(IMAGE)
