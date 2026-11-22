use serde::Serialize;
use std::fmt::Display;

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
        Self::io(e)
    }
}
