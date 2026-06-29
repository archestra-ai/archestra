KEYCLOAK_REPO ?= https://github.com/Hitachi/keycloak.git
KEYCLOAK_BRANCH ?= ISSUE-43971-IDJAGReceiver
KEYCLOAK_COMMIT ?= 5afbf425b19a3f4b4a1b5a37cba890fcfee977a4
IMAGE ?= europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/keycloak:pr46048-5afbf42
PLATFORMS ?= linux/amd64,linux/arm64
BUILD_DIR ?= /tmp/keycloak-idjag-pr46048-build
BUILDER ?= archestra-multiarch

.PHONY: clone prepare-builder js-install js-build patch-js-pom build-dist build-image publish all clean

clone:
	git clone --depth 1 --branch $(KEYCLOAK_BRANCH) $(KEYCLOAK_REPO) $(BUILD_DIR)
	cd $(BUILD_DIR) && git fetch --depth 1 origin $(KEYCLOAK_COMMIT) && git checkout $(KEYCLOAK_COMMIT)

prepare-builder:
	docker buildx inspect $(BUILDER) >/dev/null 2>&1 || docker buildx create --name $(BUILDER) --driver docker-container --use
	docker buildx inspect --bootstrap $(BUILDER)

js-install:
	docker run --rm --platform linux/amd64 \
		-v $(BUILD_DIR):/workspace \
		-w /workspace/js \
		node:24-bookworm \
		bash -lc 'corepack enable >/dev/null 2>&1 && pnpm install --frozen-lockfile'

js-build:
	docker run --rm --platform linux/amd64 \
		-v $(BUILD_DIR):/workspace \
		-w /workspace/js \
		node:24-bookworm \
		bash -lc 'corepack enable >/dev/null 2>&1 && pnpm build'

patch-js-pom:
	python3 - <<-'PY' "$(BUILD_DIR)/js/pom.xml"
	from pathlib import Path
	import re
	import sys
	pom_path = Path(sys.argv[1])
	text = pom_path.read_text()
	text = text.replace(
	    "install --prefer-offline --frozen-lockfile --ignore-scripts",
	    "install --prefer-offline --frozen-lockfile",
	    1,
	)
	pattern = re.compile(r"\s*<execution>\s*<id>pnpm-build</id>.*?</execution>", re.S)
	new_text, count = pattern.subn("\n", text, count=1)
	if count != 1:
	    raise SystemExit(f"expected 1 pnpm-build execution, got {count}")
	pom_path.write_text(new_text)
	print(f"patched {pom_path}")
	PY

build-dist:
	docker run --rm --platform linux/amd64 \
		-e PATH=/workspace/js/node:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
		-v $(BUILD_DIR):/workspace \
		-v $(HOME)/.m2:/root/.m2 \
		-w /workspace \
		maven:3.9-eclipse-temurin-21 \
		./mvnw -B -pl quarkus/dist -am install -DskipTests -DskipExamples -DskipProtoLock=true

build-image:
	cp $(BUILD_DIR)/quarkus/dist/target/keycloak-*.tar.gz $(BUILD_DIR)/quarkus/container/
	docker buildx build \
		--builder $(BUILDER) \
		--platform $(PLATFORMS) \
		--file $(BUILD_DIR)/quarkus/container/Dockerfile \
		--build-arg KEYCLOAK_DIST=$$(basename $(BUILD_DIR)/quarkus/container/keycloak-*.tar.gz) \
		--tag $(IMAGE) \
		$(BUILD_DIR)/quarkus/container

publish:
	gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet
	cp $(BUILD_DIR)/quarkus/dist/target/keycloak-*.tar.gz $(BUILD_DIR)/quarkus/container/
	docker buildx build \
		--builder $(BUILDER) \
		--platform $(PLATFORMS) \
		--file $(BUILD_DIR)/quarkus/container/Dockerfile \
		--build-arg KEYCLOAK_DIST=$$(basename $(BUILD_DIR)/quarkus/container/keycloak-*.tar.gz) \
		--tag $(IMAGE) \
		--push \
		$(BUILD_DIR)/quarkus/container

all: clone prepare-builder js-install js-build patch-js-pom build-dist publish

clean:
	rm -rf $(BUILD_DIR)
