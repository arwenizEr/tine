use serde::Serialize;
use std::fmt::Display;
use std::io::ErrorKind;

/// Every command error crosses the IPC boundary as `{ code, message }`.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Display) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }

    pub fn io(e: impl Display) -> Self {
        Self::new("io", e)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        let code = match e.kind() {
            ErrorKind::NotFound => "not_found",
            ErrorKind::AlreadyExists => "exists",
            ErrorKind::PermissionDenied => "permission",
            _ => "io",
        };
        Self::new(code, e)
    }
}

impl From<git2::Error> for AppError {
    fn from(e: git2::Error) -> Self {
        Self::new("git", e.message())
    }
}
