mod error;
mod fs;
mod pty;
mod watcher;

use error::AppError;
use pty::PtyManager;
use serde::Serialize;
use std::path::Path;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use watcher::Watcher;

/// The IPC contract says every path is absolute; reject anything else at the boundary.
fn abs(path: &str) -> Result<&Path, AppError> {
    let p = Path::new(path);
    if p.is_absolute() {
        Ok(p)
    } else {
        Err(AppError::new(
            "invalid",
            format!("{path} is not an absolute path"),
        ))
    }
}

#[derive(Clone, Serialize)]
struct PtyExit {
    pty_id: u32,
    code: Option<i32>,
}

#[derive(Clone, Serialize)]
struct FsChanged {
    root: String,
    paths: Vec<String>,
}

// Commands are async so slow disk or PTY work never stalls the main (UI) thread.
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

#[tauri::command(rename_all = "snake_case")]
async fn fs_list_dir(path: String) -> Result<Vec<fs::Entry>, AppError> {
    fs::list_dir(abs(&path)?)
}

#[tauri::command(rename_all = "snake_case")]
async fn fs_read_file(path: String) -> Result<fs::FileText, AppError> {
    fs::read_file(abs(&path)?)
}

#[tauri::command(rename_all = "snake_case")]
async fn fs_stat(path: String) -> Result<fs::Stat, AppError> {
    fs::stat(abs(&path)?)
}

#[tauri::command(rename_all = "snake_case")]
async fn fs_write_file(
    path: String,
    text: String,
    expected_mtime: Option<u64>,
) -> Result<u64, AppError> {
    fs::write_file(abs(&path)?, &text, expected_mtime)
}

#[tauri::command(rename_all = "snake_case")]
async fn fs_create_file(path: String) -> Result<(), AppError> {
    fs::create_file(abs(&path)?)
}

#[tauri::command(rename_all = "snake_case")]
async fn fs_create_dir(path: String) -> Result<(), AppError> {
    fs::create_dir(abs(&path)?)
}

#[tauri::command(rename_all = "snake_case")]
async fn fs_rename(from: String, to: String) -> Result<(), AppError> {
    fs::rename(abs(&from)?, abs(&to)?)
}

#[tauri::command(rename_all = "snake_case")]
async fn fs_trash(paths: Vec<String>) -> Result<(), AppError> {
    for p in &paths {
        abs(p)?;
    }
    fs::trash(&paths)
}

#[tauri::command(rename_all = "snake_case")]
async fn fs_reveal(path: String) -> Result<(), AppError> {
    fs::reveal(abs(&path)?)
}

/// Also opens the folder's files to the asset protocol, which serves image previews.
#[tauri::command(rename_all = "snake_case")]
async fn fs_watch(
    app: AppHandle,
    watcher: State<'_, Watcher>,
    root: String,
) -> Result<(), AppError> {
    watcher.watch(abs(&root)?.to_str().unwrap_or(&root))?;
    app.asset_protocol_scope()
        .allow_directory(&root, false)
        .map_err(AppError::io)
}

#[tauri::command(rename_all = "snake_case")]
async fn fs_unwatch(watcher: State<'_, Watcher>, root: String) -> Result<(), AppError> {
    watcher.unwatch(&root)
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

/// Native menu so Cmd+C/X/V reach the focused view as clipboard events and Cmd+Q quits.
/// Other shortcuts stay unbound here so the frontend receives them; custom items send a
/// `menu` event with their id.
#[cfg(target_os = "macos")]
fn macos_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as P, Submenu};
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
                "File",
                true,
                &[
                    &MenuItem::with_id(app, "new_file", "New File", true, Some("CmdOrCtrl+N"))?,
                    &MenuItem::with_id(
                        app,
                        "open_folder",
                        "Open Folder…",
                        true,
                        Some("CmdOrCtrl+O"),
                    )?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &P::cut(app, None)?,
                    &P::copy(app, None)?,
                    &P::paste(app, None)?,
                ],
            )?,
        ],
    )
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_cache_dir()?.join("shell-integration");
            // Without the scripts the shells still start, just without OSC 7.
            let integration = pty::install_shell_integration(&dir)
                .inspect_err(|e| eprintln!("shell integration unavailable: {e}"))
                .ok()
                .map(|_| dir);
            app.manage(PtyManager::new(integration));
            let handle = app.handle().clone();
            app.manage(
                Watcher::new(move |root, paths| {
                    let _ = handle.emit("fs-changed", FsChanged { root, paths });
                })
                .map_err(|e| e.message)?,
            );
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            fs_list_dir,
            fs_read_file,
            fs_stat,
            fs_write_file,
            fs_create_file,
            fs_create_dir,
            fs_rename,
            fs_trash,
            fs_reveal,
            fs_watch,
            fs_unwatch,
            open_url
        ]);
    #[cfg(target_os = "macos")]
    let builder = builder.menu(macos_menu);
    builder
        .build(tauri::generate_context!())
        .expect("failed to build tauri app")
        .run(|app, event| {
            if let RunEvent::Exit = event
                && let Some(ptys) = app.try_state::<PtyManager>()
            {
                ptys.kill_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{abs, is_openable_url};

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

    #[test]
    fn relative_paths_are_rejected() {
        assert!(abs("/tmp/x").is_ok());
        assert_eq!(abs("tmp/x").unwrap_err().code, "invalid");
        assert_eq!(abs("").unwrap_err().code, "invalid");
    }
}
