use thiserror::Error;

/// Errors the surface compiler raises when it cannot type or load the authoring config.
#[derive(Debug, Error)]
pub enum SurfaceError {
    #[error("failed to read `{path}`: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse `{path}`: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_yaml::Error,
    },
    #[error("declassifier `{id}` is not robust: its precondition must be `integrity: clean`")]
    IllegalDeclass { id: String },
    #[error("unknown dimension `{dim}` referenced in `{whence}`")]
    UnknownDimension { dim: String, whence: String },
    #[error("chain `{id}` references undeclared approver `{approver}`")]
    UnknownApprover { id: String, approver: String },
    #[error("approver `{approver}` has an unrecognized scope `{scope}` (expected `any` or a tool map)")]
    InvalidScope { approver: String, scope: String },
    #[error("guard `{guard}` has a value `{value}` that is not a valid {ty}")]
    InvalidGuardValue {
        guard: String,
        value: String,
        ty: String,
    },
}
