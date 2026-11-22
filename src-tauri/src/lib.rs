mod error;
mod fs;
mod git;
mod pty;
mod settings;
mod watcher;

use error::AppError;
use pty::PtyManager;
use serde::Serialize;
use std::path::Path;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use watcher::{RepoWatcher, Watcher};

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
struct GitChanged {
    repo: String,
}

#[derive(Clone, Serialize)]
struct FsChanged {
    root: String,
    paths: Vec<String>,
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    settings::default_path(&app.package_info().name)
        .ok_or_else(|| AppError::new("io", "HOME is not set"))
}

#[tauri::command(rename_all = "snake_case")]
async fn settings_load(app: AppHandle) -> Result<settings::Loaded, AppError> {
    let path = settings_path(&app)?;
    let settings = settings::load(&path)?;
    Ok(settings::Loaded {
        path: path.to_string_lossy().into_owned(),
        settings,
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn settings_set(
    app: AppHandle,
    key: String,
    value: Option<toml::Value>,
) -> Result<settings::Settings, AppError> {
    settings::set(&settings_path(&app)?, &key, value.as_ref())
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
    // A broken settings file must not stop shells from starting: fall back to $SHELL.
    let shell = settings_path(&app)
        .ok()
        .and_then(|p| settings::load(&p).ok())
        .and_then(|s| s.shell);
    ptys.spawn(
        shell,
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

/// For the command palette: every file under `root` that git does not ignore, up to 50,000.
#[tauri::command(rename_all = "snake_case")]
async fn fs_find_files(root: String) -> Result<Vec<String>, AppError> {
    fs::find_files(abs(&root)?, 50_000)
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

/// The first status call for a repo also starts watching it, so `git-changed` follows.
#[tauri::command(rename_all = "snake_case")]
async fn git_status(repos: State<'_, RepoWatcher>, repo: String) -> Result<git::Status, AppError> {
    let status = git::status(abs(&repo)?)?;
    if let Err(e) = repos.watch(&repo) {
        eprintln!("not watching {repo}: {}", e.message);
    }
    Ok(status)
}

#[tauri::command(rename_all = "snake_case")]
async fn git_diff_file(
    repo: String,
    path: String,
    staged: bool,
    base: Option<String>,
) -> Result<git::FileDiff, AppError> {
    git::diff_file(abs(&repo)?, abs(&path)?, staged, base.as_deref())
}

/// Records the working tree as a git tree object; `git_changes_since` compares against it.
#[tauri::command(rename_all = "snake_case")]
async fn git_snapshot(repo: String) -> Result<String, AppError> {
    git::snapshot(abs(&repo)?)
}

#[tauri::command(rename_all = "snake_case")]
async fn git_changes_since(repo: String, base: String) -> Result<Vec<git::FileChange>, AppError> {
    git::changes_since(abs(&repo)?, &base)
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

/// Frontend errors, written to stderr: the release webview has no console to read them from.
#[tauri::command]
fn log_error(message: String) {
    eprintln!("[tine frontend] {message}");
}

/// Whether macOS gave tine Full Disk Access. Without it, macOS asks separately for Desktop,
/// Documents, Downloads and other protected places. Always true elsewhere.
#[tauri::command]
fn full_disk_access() -> bool {
    // shortcut: the TCC database is readable only with Full Disk Access; the usual check, as macOS has no API for it.
    !cfg!(target_os = "macos")
        || std::env::var_os("HOME").is_some_and(|home| {
            std::fs::File::open(
                std::path::Path::new(&home).join("Library/Application Support/com.apple.TCC/TCC.db"),
            )
            .is_ok()
        })
}

/// Opens System Settings at Privacy & Security > Full Disk Access (macOS only).
#[tauri::command]
fn open_full_disk_access_settings() -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
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
        .plugin(tauri_plugin_notification::init())
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
            let handle = app.handle().clone();
            app.manage(
                RepoWatcher::new(move |repo| {
                    let _ = handle.emit("git-changed", GitChanged { repo });
                })
                .map_err(|e| e.message)?,
            );
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            full_disk_access,
            log_error,
            settings_set,
            open_full_disk_access_settings,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            fs_list_dir,
            fs_find_files,
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
            git_status,
            git_diff_file,
            git_snapshot,
            git_changes_since,
            settings_load,
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
