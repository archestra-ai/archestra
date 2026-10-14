//! Real SDK/CLI/engine coverage, explicitly run by on-pull-requests-dagger-sdk.yml.
//! Ordinary cargo test ignores this test; --ignored requires the isolated CI fixture
//! and fails on missing configuration or an unavailable engine, never skips.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use dagger_sdk::{
    ContainerWithExecOptsBuilder,
    core::{gql_client::GraphQlExtension, graphql_client::GraphQLError},
    errors::DaggerError,
};

// Docker Hub's official alpine:3.23.4 multi-platform manifest.
const IMAGE: &str =
    "alpine:3.23.4@sha256:5b10f432ef3da1b8d4c7eb6c487f2f5a8f096bc91145e68878dd4a5019afde11";
const SECRET: &str = "s3cret-value-7f3a";
const SECRET_SHA256: &str = "a9794f37712ef58f7758db8b2bbb0c207ee00a8c2cda0a8fb3d428868970e98a";

#[tokio::test]
#[ignore = "requires the isolated Dagger 0.21.9 fixture from on-pull-requests-dagger-sdk.yml"]
async fn real_sdk_exec_files_secrets_and_typed_errors() -> eyre::Result<()> {
    let cli = PathBuf::from(std::env::var("_EXPERIMENTAL_DAGGER_CLI_BIN")?);
    eyre::ensure!(cli.is_absolute() && cli.is_file(), "explicit CLI required");
    let runner = std::env::var("_EXPERIMENTAL_DAGGER_RUNNER_HOST")?;
    let name = runner
        .strip_prefix("docker-container://archestra-dagger-sdk-")
        .ok_or_else(|| eyre::eyre!("a task-owned Docker engine is required"))?;
    eyre::ensure!(
        !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "invalid task-owned engine name"
    );
    for key in [
        "DAGGER_SESSION_PORT",
        "DAGGER_SESSION_TOKEN",
        "DAGGER_CLOUD_TOKEN",
    ] {
        eyre::ensure!(
            std::env::var_os(key).is_none(),
            "inherited {key} is forbidden"
        );
    }
    eyre::ensure!(
        std::env::var("DOCKER_HOST")? == "unix:///var/run/docker.sock",
        "only the ephemeral runner's Docker daemon is allowed"
    );
    // Engine::start retries via the SDK cache if the explicit CLI fails. Both
    // paths must resolve to the same verified binary, not an automatic download.
    let cached_cli = PathBuf::from(std::env::var("XDG_CACHE_HOME")?).join("dagger/dagger-0.21.9");
    eyre::ensure!(
        cached_cli.canonicalize()? == cli.canonicalize()?,
        "SDK fallback must use the same verified CLI"
    );

    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let path = std::env::temp_dir().join(format!("dagger-sdk-{}-{nonce}", std::process::id()));
    fs::create_dir(&path)?;
    let fixture = FixtureDir(path);
    let input_path = fixture.0.join("input.txt");
    let input = format!("host-file-{nonce}: \"quoted\" \\ content\n");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&input_path)?
        .write_all(input.as_bytes())?;

    let config = dagger_sdk::Config::builder()
        .workdir_path(fixture.0.clone())
        .timeout_ms(30_000)
        .execute_timeout_ms(120_000)
        .build();
    tokio::time::timeout(
        Duration::from_secs(240),
        dagger_sdk::connect_opts(config, move |client| async move {
            let version = client.version().await?;
            eyre::ensure!(
                version.trim_start_matches('v') == "0.21.9",
                "wrong engine: {version}"
            );

            let base = client.container().from(IMAGE);
            let imported = client
                .host()
                .file(input_path.to_string_lossy().into_owned());
            let execution = base.with_file("/input.txt", imported).with_exec_opts(
                vec![
                    "sh",
                    "-ec",
                    "cat; cat /input.txt; cp /input.txt /artifact.txt",
                ],
                ContainerWithExecOptsBuilder::default()
                    .stdin("stdin-payload\n")
                    .build()?,
            );
            eyre::ensure!(
                execution.exit_code().await? == 0,
                "successful exec exit code"
            );
            eyre::ensure!(
                execution.stdout().await? == format!("stdin-payload\n{input}"),
                "stdin/file stdout round trip"
            );
            eyre::ensure!(
                execution.stderr().await?.is_empty(),
                "unexpected successful exec stderr"
            );
            eyre::ensure!(
                execution.file("/artifact.txt").contents().await? == input,
                "artifact contents round trip"
            );

            let secret = client.set_secret(format!("sdk-smoke-{nonce}"), SECRET);
            let hashed = base
                .with_secret_variable("SDK_SMOKE_SECRET", secret)
                .with_exec(vec![
                    "sh",
                    "-ec",
                    "printf %s \"$SDK_SMOKE_SECRET\" | sha256sum | cut -c1-64",
                ])
                .stdout()
                .await?;
            eyre::ensure!(
                hashed.trim_end() == SECRET_SHA256,
                "secret environment hash mismatch"
            );

            let error = match base
                .with_exec(vec![
                    "sh",
                    "-c",
                    "printf sdk-out; printf sdk-err >&2; exit 23",
                ])
                .sync()
                .await
            {
                Ok(_) => eyre::bail!("nonzero exec must return a typed error"),
                Err(error) => error,
            };
            let DaggerError::Query(GraphQLError::DomainError { fields, .. }) = error else {
                eyre::bail!("exec failure lost its GraphQL domain error: {error}");
            };
            let extension = fields.iter().find_map(|field| match &field.extensions {
                Some(GraphQlExtension::ExecError {
                    exit_code,
                    stdout,
                    stderr,
                    ..
                }) => Some((*exit_code, stdout.as_str(), stderr.as_str())),
                _ => None,
            });
            eyre::ensure!(
                extension == Some((23, "sdk-out", "sdk-err")),
                "EXEC_ERROR lost exit/stdout/stderr: {fields:?}"
            );
            // Normal connect_opts shutdown is part of the awaited result.
            Ok(())
        }),
    )
    .await??;
    drop(fixture);
    Ok(())
}

struct FixtureDir(PathBuf);

impl Drop for FixtureDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
