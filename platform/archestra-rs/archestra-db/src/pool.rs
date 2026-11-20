use std::{env, fs, io, net::IpAddr, path::PathBuf, time::Duration};

use diesel::result::ConnectionError;
use diesel_async::{
    AsyncPgConnection,
    pooled_connection::{AsyncDieselConnectionManager, ManagerConfig, bb8},
};
use native_tls::{Certificate, TlsConnector};
use postgres_native_tls::MakeTlsConnector;
use tokio_postgres::{
    Config, NoTls,
    config::{Host, SslMode},
};
use url::{Url, form_urlencoded};

use crate::managed_auth::AuthMethod;

pub type PgPool = bb8::Pool<AsyncPgConnection>;

pub async fn pilot_pool(database_url: &str) -> io::Result<PgPool> {
    let method = AuthMethod::from_environment()?;
    let (mut config, transport) = connection_settings(database_url, method)?;
    let [Host::Tcp(host)] = config.get_hosts() else {
        return Err(io::Error::other("expected one PostgreSQL TCP host"));
    };
    let auth = method.provider(&config, host).await?;
    let connect_timeout = Duration::from_secs(if method.is_managed() { 15 } else { 5 });
    if method.is_managed() {
        config.password("");
    }
    let mut manager = ManagerConfig::default();
    manager.custom_setup = Box::new(move |_| {
        let (mut config, transport, auth) = (config.clone(), transport.clone(), auth.clone());
        Box::pin(async move {
            let connect_error =
                |_| ConnectionError::BadConnection("PostgreSQL connection failed".into());
            tokio::time::timeout(connect_timeout, async {
                auth.apply(&mut config).await?;
                match transport {
                    Transport::VerifiedTls(tls) => {
                        let (client, connection) =
                            config.connect(tls).await.map_err(connect_error)?;
                        AsyncPgConnection::try_from_client_and_connection(client, connection).await
                    }
                    Transport::PlaintextLoopback => {
                        let (client, connection) =
                            config.connect(NoTls).await.map_err(connect_error)?;
                        AsyncPgConnection::try_from_client_and_connection(client, connection).await
                    }
                }
            })
            .await
            .map_err(|_| {
                ConnectionError::BadConnection("PostgreSQL connection setup timed out".into())
            })?
        })
    });
    let pool = PgPool::builder()
        .max_size(1)
        .connection_timeout(connect_timeout)
        .build_unchecked(AsyncDieselConnectionManager::new_with_config("", manager));
    pool.get()
        .await
        .map_err(|_| io::Error::other("could not connect to the Rust database"))?;
    Ok(pool)
}

#[derive(Clone)]
enum Transport {
    PlaintextLoopback,
    VerifiedTls(MakeTlsConnector),
}

fn connection_settings(database_url: &str, method: AuthMethod) -> io::Result<(Config, Transport)> {
    let invalid_url = || io::Error::other("expected a PostgreSQL URL with one TCP host");
    let mut url = Url::parse(database_url).map_err(|_| invalid_url())?;
    if !matches!(url.scheme(), "postgres" | "postgresql") || url.fragment().is_some() {
        return Err(invalid_url());
    }
    let (mut mode, mut ca, mut remaining) = (None, None, Vec::new());
    for pair in url
        .query()
        .unwrap_or_default()
        .split('&')
        .filter(|s| !s.is_empty())
    {
        let (key, value) = form_urlencoded::parse(pair.as_bytes())
            .next()
            .ok_or_else(invalid_url)?;
        match key.as_ref() {
            "sslmode" if mode.is_none() => mode = Some(value.into_owned()),
            "sslrootcert" if ca.is_none() => ca = Some(PathBuf::from(value.into_owned())),
            "sslmode" | "sslrootcert" | "host" | "hostaddr" => return Err(invalid_url()),
            "uselibpqcompat" if method.is_managed() => {}
            _ => remaining.push(pair),
        }
    }
    let query = (!remaining.is_empty()).then(|| remaining.join("&"));
    url.set_query(query.as_deref());
    let mut config: Config = url.as_str().parse().map_err(|_| invalid_url())?;
    let [Host::Tcp(host)] = config.get_hosts() else {
        return Err(invalid_url());
    };
    let loopback = host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    let mode = match mode {
        Some(mode) => Some(mode),
        None => match env::var("PGSSLMODE") {
            Ok(mode) => Some(mode),
            Err(env::VarError::NotPresent) => None,
            Err(env::VarError::NotUnicode(_)) => return Err(io::Error::other("invalid PGSSLMODE")),
        },
    };
    let ca = ca.or_else(|| env::var_os("PGSSLROOTCERT").map(PathBuf::from));
    if method.is_managed() {
        if !matches!(
            mode.as_deref(),
            None | Some("verify-full" | "verify-ca" | "require" | "prefer")
        ) {
            return Err(io::Error::other(
                "managed PostgreSQL authentication requires verified TLS",
            ));
        }
        if config.get_user().is_none_or(str::is_empty) {
            return Err(io::Error::other(
                "managed PostgreSQL authentication requires a database user",
            ));
        }
        config.ssl_mode(SslMode::Require);
        return Ok((config, Transport::VerifiedTls(tls_connector(ca)?)));
    }
    match mode.as_deref() {
        Some("verify-full") => {
            config.ssl_mode(SslMode::Require);
            Ok((config, Transport::VerifiedTls(tls_connector(ca)?)))
        }
        None | Some("disable") if loopback && ca.is_none() => {
            config.ssl_mode(SslMode::Disable);
            Ok((config, Transport::PlaintextLoopback))
        }
        _ => Err(io::Error::other(
            "Rust PostgreSQL requires sslmode=verify-full unless using a literal loopback address without TLS",
        )),
    }
}

fn tls_connector(ca: Option<PathBuf>) -> io::Result<MakeTlsConnector> {
    let mut builder = TlsConnector::builder();
    if let Some(path) = ca {
        let pem =
            fs::read(path).map_err(|_| io::Error::other("could not read PostgreSQL CA file"))?;
        let invalid_pem = |_| io::Error::other("invalid PostgreSQL CA bundle");
        let roots = Certificate::stack_from_pem(&pem).map_err(invalid_pem)?;
        if roots.is_empty() {
            return Err(io::Error::other("empty PostgreSQL CA bundle"));
        }
        builder.disable_built_in_roots(true);
        for root in roots {
            builder.add_root_certificate(root);
        }
    }
    builder
        .build()
        .map(MakeTlsConnector::new)
        .map_err(|_| io::Error::other("could not configure PostgreSQL TLS"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_auth_rejects_unverified_tls_even_on_loopback() {
        for method in [AuthMethod::RdsIam, AuthMethod::Entra] {
            for mode in ["disable", "no-verify", "allow"] {
                let url = format!("postgresql://test@127.0.0.1/test?sslmode={mode}");
                assert!(connection_settings(&url, method).is_err());
            }
            let url = "postgresql://test@127.0.0.1/test?sslmode=require";
            let (config, transport) = connection_settings(url, method).unwrap();
            assert_eq!(config.get_ssl_mode(), SslMode::Require);
            assert!(matches!(transport, Transport::VerifiedTls(_)));
        }
    }
}
