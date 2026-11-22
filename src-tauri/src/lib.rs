mod error;
mod pty;

use error::AppError;
use pty::PtyManager;
use serde::Serialize;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[derive(Clone, Serialize)]
struct PtyExit {
    pty_id: u32,
    code: Option<i32>,
}

// Commands are async so a blocked PTY write never stalls the main (UI) thread.
#[tauri::command(rename_all = "snake_case")]
async fn pty_spawn(
    app: AppHandle,
    ptys: State<'_, PtyManager>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<Response>,
) -> Result<u32, AppError> {
    ptys.spawn(
        cwd,
        cols,
        rows,
        move |bytes| {
            let _ = on_data.send(Response::new(bytes));
        },
        move |pty_id, code| {
            let _ = app.emit("pty-exit", PtyExit { pty_id, code });
        },
    )
}

#[tauri::command(rename_all = "snake_case")]
async fn pty_write(ptys: State<'_, PtyManager>, pty_id: u32, data: String) -> Result<(), AppError> {
    ptys.write(pty_id, data.as_bytes())
}

#[tauri::command(rename_all = "snake_case")]
async fn pty_resize(
    ptys: State<'_, PtyManager>,
    pty_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    ptys.resize(pty_id, cols, rows)
}

#[tauri::command(rename_all = "snake_case")]
async fn pty_kill(ptys: State<'_, PtyManager>, pty_id: u32) -> Result<(), AppError> {
    ptys.kill(pty_id)
}

/// Only links meant for a browser or mail client; never `file:` or custom schemes from untrusted output.
fn is_openable_url(url: &str) -> bool {
    ["https://", "http://", "mailto:"].iter().any(|p| {
        url.len() > p.len()
            && url
                .get(..p.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(p))
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn open_url(url: String) -> Result<(), AppError> {
    if !is_openable_url(&url) {
        return Err(AppError::new("invalid", format!("refusing to open {url}")));
    }
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    // `--` stops a URL that starts with `-` being read as an option.
    std::process::Command::new(opener)
        .arg("--")
        .arg(&url)
        .spawn()?;
    Ok(())
}

/// Native menu so Cmd+C/Cmd+V reach the terminal as copy/paste events and Cmd+Q quits.
/// Cmd+T/W/K/1-9 are left unbound here so the frontend receives them.
#[cfg(target_os = "macos")]
fn macos_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
    let name = app.package_info().name.clone();
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                name,
                true,
                &[
                    &P::about(app, None, None)?,
                    &P::separator(app)?,
                    &P::hide(app, None)?,
                    &P::hide_others(app, None)?,
                    &P::separator(app)?,
                    &P::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[&P::copy(app, None)?, &P::paste(app, None)?],
            )?,
        ],
    )
}

pub fn run() {
    let builder = tauri::Builder::default()
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn, pty_write, pty_resize, pty_kill, open_url
        ]);
    #[cfg(target_os = "macos")]
    let builder = builder.menu(macos_menu);
    builder
        .build(tauri::generate_context!())
        .expect("failed to build tauri app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<PtyManager>().kill_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::is_openable_url;

    #[test]
    fn only_web_and_mail_links_open() {
        assert!(is_openable_url("https://example.com"));
        assert!(is_openable_url("HTTP://example.com/a?b"));
        assert!(is_openable_url("mailto:a@example.com"));
        assert!(!is_openable_url("https://"));
        assert!(!is_openable_url("file:///etc/passwd"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("-a Calculator"));
        assert!(!is_openable_url("vscode://x"));
        assert!(!is_openable_url("httpş://x")); // multi-byte at the prefix boundary must not panic
    }
}
