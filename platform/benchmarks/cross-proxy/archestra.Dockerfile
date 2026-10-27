FROM ubuntu:24.04@sha256:a2d43bffc46670d7108bb3c0468c67c5557c4c92e83e1e34cbff1322ad1b94dc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libssl3t64 && rm -rf /var/lib/apt/lists/*
