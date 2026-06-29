PYTHON_VERSION := 3.12
PYTHON_PLATFORM := x86_64-unknown-linux-musl

.PHONY: update-python-lockfile
update-python-lockfile:
	uv pip compile \
		pyproject.toml \
		--python-version $(PYTHON_VERSION) \
		--python-platform $(PYTHON_PLATFORM) \
		--generate-hashes \
		--output-file requirements.lock
