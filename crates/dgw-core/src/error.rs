use thiserror::Error;

pub type Result<T> = std::result::Result<T, DgwError>;

#[derive(Debug, Error)]
pub enum DgwError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid VCF: {0}")]
    InvalidVcf(String),
    #[error("invalid resource bundle: {0}")]
    InvalidResource(String),
    #[error("invalid edit: {0}")]
    InvalidEdit(String),
    #[error("invalid device: {0}")]
    InvalidDevice(String),
    #[error("project error: {0}")]
    Project(String),
    #[error("external tool failed: {0}")]
    Tool(String),
    #[error("operation timed out: {0}")]
    Timeout(String),
}
