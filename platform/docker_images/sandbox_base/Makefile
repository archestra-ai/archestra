PYTHON_VERSION := 3.12

# Regenerate the hashed lockfile after editing pyproject.toml. Universal so the
# image can build for both linux/amd64 and linux/arm64 from one lock.
.PHONY: update-lockfile
update-lockfile:
	uv pip compile \
		pyproject.toml \
		--python-version $(PYTHON_VERSION) \
		--universal \
		--generate-hashes \
		--output-file requirements.lock
