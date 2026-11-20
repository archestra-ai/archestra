use std::{
    env, io,
    sync::Arc,
    time::{Duration, SystemTime},
};

use aws_config::{Region, default_provider::credentials::DefaultCredentialsChain};
use aws_credential_types::{Credentials, provider::ProvideCredentials};
use aws_sigv4::{
    http_request::{SignableBody, SignableRequest, SignatureLocation, SigningSettings, sign},
    sign::v4,
};
use azure_core::credentials::TokenCredential;
use azure_identity::{
    ClientSecretCredential, ManagedIdentityCredential, ManagedIdentityCredentialOptions,
    UserAssignedId, WorkloadIdentityCredential,
};
use diesel::result::ConnectionError;
use tokio_postgres::Config;

#[derive(Clone, Copy)]
pub(super) enum AuthMethod {
    Password,
    RdsIam,
    Entra,
}

impl AuthMethod {
    pub(super) fn from_environment() -> io::Result<Self> {
        match (
            env::var("ARCHESTRA_DATABASE_IAM_AUTH_ENABLED").as_deref() == Ok("true"),
            env::var("ARCHESTRA_DATABASE_ENTRA_AUTH_ENABLED").as_deref() == Ok("true"),
        ) {
            (false, false) => Ok(Self::Password),
            (true, false) => Ok(Self::RdsIam),
            (false, true) => Ok(Self::Entra),
            (true, true) => Err(io::Error::other(
                "enable only one managed PostgreSQL authentication method",
            )),
        }
    }

    pub(super) fn is_managed(self) -> bool {
        !matches!(self, Self::Password)
    }

    pub(super) async fn provider(self, config: &Config, host: &str) -> io::Result<AuthProvider> {
        match self {
            Self::Password => Ok(AuthProvider::Password),
            Self::RdsIam => {
                let region = env_text("ARCHESTRA_DATABASE_AWS_REGION")
                    .or_else(|| rds_region(host))
                    .or_else(|| env_text("AWS_REGION"))
                    .or_else(|| env_text("AWS_DEFAULT_REGION"))
                    .ok_or_else(|| {
                        io::Error::other("could not determine the RDS database region")
                    })?;
                let port = match config.get_ports() {
                    [port] if *port != 0 => *port,
                    _ => return Err(io::Error::other("expected one valid RDS port")),
                };
                let username = config.get_user().ok_or_else(|| {
                    io::Error::other("RDS authentication requires a database user")
                })?;
                let query = url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("Action", "connect")
                    .append_pair("DBUser", username)
                    .finish()
                    .replace('+', "%20");
                let authority = format!("{}:{port}", host.trim_end_matches('.'));
                let uri = format!("https://{authority}/?{query}")
                    .parse::<http::Uri>()
                    .map_err(|_| io::Error::other("invalid RDS endpoint"))?;
                if uri.authority().map(http::uri::Authority::as_str) != Some(&authority) {
                    return Err(io::Error::other("invalid RDS endpoint authority"));
                }
                let chain = DefaultCredentialsChain::builder()
                    .region(Region::new(region.clone()))
                    .build()
                    .await;
                Ok(AuthProvider::RdsIam {
                    chain: Arc::new(chain),
                    uri,
                    region,
                })
            }
            Self::Entra => Ok(AuthProvider::Entra {
                credential: entra_credential()?,
                scope: entra_scope(host),
            }),
        }
    }
}

#[derive(Clone)]
pub(super) enum AuthProvider {
    Password,
    RdsIam {
        chain: Arc<DefaultCredentialsChain>,
        uri: http::Uri,
        region: String,
    },
    Entra {
        credential: Arc<dyn TokenCredential>,
        scope: &'static str,
    },
}

impl AuthProvider {
    pub(super) async fn apply(&self, config: &mut Config) -> Result<(), ConnectionError> {
        match self {
            Self::Password => {}
            Self::RdsIam { chain, uri, region } => {
                let credentials = chain
                    .provide_credentials()
                    .await
                    .map_err(|_| rds_credential_error())?;
                config.password(rds_token(uri, region, credentials, SystemTime::now())?);
            }
            Self::Entra { credential, scope } => {
                let error = || {
                    ConnectionError::BadConnection(
                        "could not obtain Entra database credentials".into(),
                    )
                };
                let token = credential
                    .get_token(&[scope], None)
                    .await
                    .map_err(|_| error())?;
                if token.token.secret().is_empty()
                    || token.expires_on <= time::OffsetDateTime::now_utc()
                {
                    return Err(error());
                }
                config.password(token.token.secret());
            }
        }
        Ok(())
    }
}

fn rds_token(
    uri: &http::Uri,
    region: &str,
    credentials: Credentials,
    now: SystemTime,
) -> Result<String, ConnectionError> {
    let authority = uri.authority().ok_or_else(rds_credential_error)?.as_str();
    let identity = credentials.into();
    let mut settings = SigningSettings::default();
    settings.signature_location = SignatureLocation::QueryParams;
    settings.expires_in = Some(Duration::from_secs(900));
    let signing = v4::SigningParams::builder()
        .identity(&identity)
        .region(region)
        .name("rds-db")
        .time(now)
        .settings(settings)
        .build()
        .map_err(|_| rds_credential_error())?
        .into();
    let mut request = http::Request::get(uri.clone())
        .body(())
        .map_err(|_| rds_credential_error())?;
    let url = uri.to_string();
    let input = SignableRequest::new(
        "GET",
        &url,
        [("host", authority)].into_iter(),
        SignableBody::Bytes(&[]),
    )
    .map_err(|_| rds_credential_error())?;
    let (instructions, _) = sign(input, &signing)
        .map_err(|_| rds_credential_error())?
        .into_parts();
    instructions.apply_to_request_http1x(&mut request);
    Ok(request
        .uri()
        .to_string()
        .strip_prefix("https://")
        .ok_or_else(rds_credential_error)?
        .to_owned())
}

fn rds_credential_error() -> ConnectionError {
    ConnectionError::BadConnection("could not obtain RDS database credentials".into())
}

fn entra_credential() -> io::Result<Arc<dyn TokenCredential>> {
    let malformed = |_| io::Error::other("could not configure the Entra database credential");
    if let Some(secret) = env::var_os("AZURE_CLIENT_SECRET") {
        let secret = secret
            .into_string()
            .map_err(|_| io::Error::other("invalid Entra client secret"))?;
        let tenant = env_text("AZURE_TENANT_ID")
            .ok_or_else(|| io::Error::other("Entra client secret requires AZURE_TENANT_ID"))?;
        let client = env_text("AZURE_CLIENT_ID")
            .ok_or_else(|| io::Error::other("Entra client secret requires AZURE_CLIENT_ID"))?;
        return Ok(
            ClientSecretCredential::new(&tenant, client, secret.into(), None).map_err(malformed)?,
        );
    }
    if env::var_os("AZURE_FEDERATED_TOKEN_FILE").is_some() {
        return Ok(WorkloadIdentityCredential::new(None).map_err(malformed)?);
    }
    let options = ManagedIdentityCredentialOptions {
        user_assigned_id: env_text("AZURE_CLIENT_ID").map(UserAssignedId::ClientId),
        ..Default::default()
    };
    Ok(ManagedIdentityCredential::new(Some(options)).map_err(malformed)?)
}

fn env_text(name: &str) -> Option<String> {
    let value = env::var(name).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn rds_region(host: &str) -> Option<String> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let endpoint = host
        .strip_suffix(".rds.amazonaws.com.cn")
        .or_else(|| host.strip_suffix(".rds.amazonaws.com"))?;
    let (_, region) = endpoint.rsplit_once('.')?;
    let (prefix, number) = region.rsplit_once('-')?;
    (prefix.contains('-') && !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
        .then(|| region.to_owned())
}

fn entra_scope(host: &str) -> &'static str {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.ends_with(".postgres.database.usgovcloudapi.net") {
        "https://ossrdbms-aad.database.usgovcloudapi.net/.default"
    } else if host.ends_with(".postgres.database.chinacloudapi.cn") {
        "https://ossrdbms-aad.database.chinacloudapi.cn/.default"
    } else {
        "https://ossrdbms-aad.database.windows.net/.default"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rds_signature_matches_typescript_with_explicit_port_and_encoded_credentials() {
        let uri = "https://db.example.test:443/?Action=connect&DBUser=a%2Bb%20test"
            .parse()
            .unwrap();
        let credentials = Credentials::new(
            "AKIDEXAMPLE",
            "disposable-test-key",
            Some("test+session/token=".into()),
            None,
            "fixture",
        );
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_767_225_600);
        let token = rds_token(&uri, "us-east-1", credentials, now).unwrap();
        let parsed = url::Url::parse(&format!("https://{token}")).unwrap();
        let params = parsed
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(params["DBUser"], "a+b test");
        assert_eq!(params["X-Amz-Expires"], "900");
        assert_eq!(params["X-Amz-Security-Token"], "test+session/token=");
        assert_eq!(
            params["X-Amz-Signature"],
            "5e54bae6fc3cb09d88577bc625d5c89405ffeb4962681975e1e7b8abb5f95c61"
        );
    }
}
