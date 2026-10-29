use std::{sync::Arc, time::Duration};

use base64::{Engine, engine::general_purpose::URL_SAFE};
use dagger_sdk::{
    Config, Query,
    core::{
        connect_params::ConnectParams,
        gql_client::GraphQlExtension,
        graphql_client::{DefaultGraphQLClient, GraphQLClient, GraphQLError},
    },
    errors::DaggerError,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
    time::timeout,
};

#[tokio::test]
async fn generated_query_round_trips_json_and_session_auth() {
    let (client, request) = serve_response(
        "200 OK",
        r#"{"data":{"container":{"from":{"withExec":{"stdout":"wire canary\n"}}}}}"#,
    )
    .await;
    let stdout = client
        .container()
        .from("alpine:3.22")
        .with_exec(vec!["printf", "wire \"canary\"\n"])
        .stdout()
        .await
        .unwrap();

    assert_eq!(stdout, "wire canary\n");
    assert_eq!(
        request.await.unwrap(),
        json!({
            "query": r#"query{container{from(address:"alpine:3.22"){withExec(args:["printf","wire \"canary\"\n"]){stdout}}}}"#,
            "variables": null,
        })
    );
}

#[tokio::test]
async fn engine_exec_error_survives_http_and_graphql_decoding() {
    let (client, request) = serve_response(
        "200 OK",
        r#"{"errors":[{"message":"canary exited","path":["container","stdout"],"extensions":{"_type":"EXEC_ERROR","cmd":["sh","-c","exit 17"],"exitCode":17,"stdout":"canary out","stderr":"canary err"}}]}"#,
    )
    .await;
    let error = client.container().stdout().await.unwrap_err();
    let DaggerError::Query(GraphQLError::DomainError { message, fields }) = error else {
        panic!("expected typed engine error, got {error:?}");
    };
    assert_eq!(message, "canary exited");
    assert_eq!(fields.len(), 1);
    let Some(GraphQlExtension::ExecError {
        cmd,
        exit_code,
        stdout,
        stderr,
    }) = &fields[0].extensions
    else {
        panic!("missing EXEC_ERROR extension");
    };
    assert_eq!(cmd, &["sh", "-c", "exit 17"]);
    assert_eq!(*exit_code, 17);
    assert_eq!(stdout, "canary out");
    assert_eq!(stderr, "canary err");
    request.await.unwrap();
}

#[tokio::test]
async fn http_status_and_invalid_json_remain_transport_errors() {
    for (status, body, expected) in [
        ("503 Service Unavailable", r#"{"data":null}"#, "503"),
        ("200 OK", "not json", "Failed to parse response"),
    ] {
        let (client, request) = serve_response(status, body).await;
        let error = client.version().await.unwrap_err();
        let DaggerError::Query(GraphQLError::HttpError(message)) = error else {
            panic!("expected transport error, got {error:?}");
        };
        assert!(message.contains(expected), "{message}");
        request.await.unwrap();
    }
}

#[tokio::test]
async fn execution_timeout_ends_a_request_without_an_engine_response() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let client = DefaultGraphQLClient::new(
        &ConnectParams::new(u64::from(port), "wire-canary-session"),
        &Config {
            execute_timeout_ms: Some(100),
            ..Config::default()
        },
    );
    let request = tokio::spawn(async move { client.query("query{version}").await });
    let (stream, _) = timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();

    // Keep the socket open without responding. A missing SDK deadline must hit
    // the outer harness deadline, not pass as a server disconnect.
    let error = timeout(Duration::from_secs(2), request)
        .await
        .expect("SDK execution timeout was not enforced")
        .unwrap()
        .unwrap_err();
    assert!(matches!(error, GraphQLError::HttpError(_)), "{error:?}");
    drop(stream);
}

// Only the engine's HTTP boundary is synthetic: all query generation, JSON,
// authentication and error decoding run through the actual patched SDK.
async fn serve_response(status: &'static str, body: &'static str) -> (Query, JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let request = tokio::spawn(async move {
        timeout(Duration::from_secs(5), async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let (body_start, content_length) = loop {
                let mut chunk = [0; 1024];
                let count = stream.read(&mut chunk).await.unwrap();
                assert_ne!(count, 0, "request closed before headers");
                bytes.extend_from_slice(&chunk[..count]);
                assert!(bytes.len() < 64 * 1024, "oversized canary request");
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = std::str::from_utf8(&bytes[..end]).unwrap();
                    assert!(headers.starts_with("POST /query HTTP/1.1\r\n"));
                    let headers: Vec<_> = headers
                        .lines()
                        .skip(1)
                        .map(|line| line.split_once(':').unwrap())
                        .collect();
                    let header = |name: &str| {
                        headers
                            .iter()
                            .find(|(key, _)| key.eq_ignore_ascii_case(name))
                            .unwrap()
                            .1
                            .trim()
                    };
                    assert_eq!(header("content-type"), "application/json");
                    assert_eq!(
                        header("authorization"),
                        format!("Basic {}", URL_SAFE.encode("wire-canary-session:"))
                    );
                    break (end + 4, header("content-length").parse::<usize>().unwrap());
                }
            };
            assert!(content_length < 64 * 1024);
            while bytes.len() < body_start + content_length {
                let mut chunk = [0; 1024];
                let count = stream.read(&mut chunk).await.unwrap();
                assert_ne!(count, 0, "request closed before JSON body");
                bytes.extend_from_slice(&chunk[..count]);
            }
            let request = serde_json::from_slice(&bytes[body_start..body_start + content_length])
                .unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
            request
        })
        .await
        .expect("loopback SDK request timed out")
    });
    let client = Query {
        proc: None,
        selection: Default::default(),
        graphql_client: Arc::new(DefaultGraphQLClient::new(
            &ConnectParams::new(u64::from(port), "wire-canary-session"),
            &Config {
                execute_timeout_ms: Some(5_000),
                ..Config::default()
            },
        )),
    };
    (client, request)
}
