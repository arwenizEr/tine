mod error;
mod fs;
mod git;
mod pty;
mod sandbox;
mod settings;
mod watcher;

use error::AppError;
use pty::PtyManager;
use serde::Serialize;
use std::path::Path;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use watcher::{RepoWatcher, Watcher};

/// Every path the frontend sends must be absolute; anything else is rejected here.
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

/// The rules for a restricted tab, from the `[sandbox]` settings.
/// `claude_dir` becomes Claude Code's config folder in the tab: its own, because the real
/// ~/.claude and ~/.claude.json hold hooks and MCP servers that run outside the sandbox.
fn restricted_policy(
    s: &settings::Sandbox,
    settings_file: &Path,
    claude_dir: &Path,
) -> Result<sandbox::Policy, AppError> {
    let home =
        std::env::var_os("HOME").ok_or_else(|| AppError::new("sandbox", "HOME is not set"))?;
    let home = Path::new(&home);
    fn expand<'a>(list: impl IntoIterator<Item = &'a str>, home: &Path) -> Vec<std::path::PathBuf> {
        list.into_iter()
            .map(|p| settings::expand_home(p, home))
            .collect()
    }
    let mut writable = match &s.writable {
        Some(list) => expand(list.iter().map(String::as_str), home),
        None => expand(settings::SANDBOX_WRITABLE, home),
    };
    std::fs::create_dir_all(claude_dir)?;
    writable.extend([
        std::env::temp_dir(),
        "/private/tmp".into(),
        claude_dir.to_path_buf(),
    ]);
    let mut deny_read = expand(settings::SANDBOX_DENY_READ, home);
    deny_read.extend(expand(s.deny_read.iter().map(String::as_str), home));
    Ok(sandbox::Policy {
        writable,
        deny_read,
        // The whole settings folder: replacing the file by renaming one beside it counts too.
        deny_write: settings_file
            .parent()
            .map(Path::to_path_buf)
            .into_iter()
            .collect(),
        network: s.network.unwrap_or(true),
        env: vec![
            ("CLAUDE_CONFIG_DIR".into(), claude_dir.into()),
            // Its updater writes to ~/.local, which the sandbox does not allow.
            ("DISABLE_AUTOUPDATER".into(), "1".into()),
        ],
    })
}

// Commands are async so slow disk or PTY work never stalls the main (UI) thread.
#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
async fn pty_spawn(
    app: AppHandle,
    ptys: State<'_, PtyManager>,
    cwd: Option<String>,
    token: Option<String>,
    sandbox: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<Response>,
) -> Result<u32, AppError> {
    let policy = match sandbox.as_deref() {
        None => None,
        Some("restricted") => {
            // Unlike the shell setting below, a broken settings file must not loosen the sandbox.
            let path = settings_path(&app)?;
            let s = settings::load(&path)
                .map_err(|e| AppError::new("sandbox", format!("settings: {}", e.message)))?;
            let claude = app
                .path()
                .app_data_dir()
                .map_err(AppError::io)?
                .join("sandbox-claude");
            Some(sandbox::Sandbox::Restricted(restricted_policy(
                &s.sandbox, &path, &claude,
            )?))
        }
        Some("isolated") => {
            let s = settings::load(&settings_path(&app)?)
                .map_err(|e| AppError::new("sandbox", format!("settings: {}", e.message)))?;
            Some(sandbox::Sandbox::Isolated(sandbox::Isolated {
                image: s
                    .sandbox
                    .image
                    .unwrap_or_else(|| settings::SANDBOX_IMAGE.into()),
                network: s.sandbox.network.unwrap_or(true),
            }))
        }
        Some(other) => {
            return Err(AppError::new(
                "invalid",
                format!("unknown sandbox \"{other}\""),
            ));
        }
    };
    // A broken settings file must not stop shells from starting: fall back to $SHELL.
    let shell = settings_path(&app)
        .ok()
        .and_then(|p| settings::load(&p).ok())
        .and_then(|s| s.shell);
    ptys.spawn(
        shell,
        cwd,
        token,
        policy,
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

/// Text search for the palette's search mode: up to 500 matching lines under `root`.
#[tauri::command(rename_all = "snake_case")]
async fn fs_search(root: String, query: String) -> Result<Vec<fs::Match>, AppError> {
    fs::search(abs(&root)?, &query, 500)
}

#[tauri::command(rename_all = "snake_case")]
async fn fs_read_file(path: String) -> Result<fs::FileText, AppError> {
    fs::read_file(abs(&path)?)
}

#[tauri::command(rename_all = "snake_case")]
async fn fs_read_image(path: String) -> Result<Response, AppError> {
    fs::read_image(abs(&path)?).map(Response::new)
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

#[tauri::command(rename_all = "snake_case")]
async fn fs_watch(watcher: State<'_, Watcher>, root: String) -> Result<(), AppError> {
    watcher.watch(abs(&root)?.to_str().unwrap_or(&root))
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

/// The fork point from the default branch, for listing a branch's whole work.
#[tauri::command(rename_all = "snake_case")]
async fn git_branch_base(repo: String) -> Result<Option<git::BranchBase>, AppError> {
    git::branch_base(abs(&repo)?)
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

/// The web panel: a second webview inside the main window, laid over the slot the frontend
/// keeps for it (positions in CSS pixels). Pages get no IPC: capabilities apply only to
/// local content unless they list remote URLs, and ours list none.
const WEB: &str = "web";

fn web_url(url: &str) -> Result<tauri::Url, AppError> {
    let parsed: tauri::Url = url
        .parse()
        .map_err(|_| AppError::new("invalid", format!("{url} is not a web address")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::new("invalid", format!("refusing to open {url}")));
    }
    Ok(parsed)
}

fn web_err(e: tauri::Error) -> AppError {
    AppError::new("web", e.to_string())
}

/// Where the slot is in the window. `x, y, width, height` are CSS pixels; `viewport` is the
/// page's height. On macOS the main webview runs under the title bar and WebKit starts the
/// page below it, so the webview's height minus `viewport` is how far CSS y=0 sits down.
fn web_rect(
    app: &AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport: f64,
) -> tauri::Rect {
    let top = app
        .get_webview("main")
        .and_then(|m| {
            let scale = m.window().scale_factor().ok()?;
            Some(m.size().ok()?.to_logical::<f64>(scale).height - viewport)
        })
        .unwrap_or(0.0)
        .max(0.0);
    tauri::Rect {
        position: tauri::LogicalPosition::new(x, y + top).into(),
        size: tauri::LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn web_show(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport: f64,
) -> Result<(), AppError> {
    let url = web_url(&url)?;
    if let Some(web) = app.get_webview(WEB) {
        web.navigate(url).map_err(web_err)?;
        web.set_bounds(web_rect(&app, x, y, width, height, viewport))
            .map_err(web_err)?;
        return web.show().map_err(web_err);
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| AppError::new("web", "no main window"))?;
    let rect = web_rect(&app, x, y, width, height, viewport);
    window
        .add_child(
            tauri::webview::WebviewBuilder::new(WEB, tauri::WebviewUrl::External(url)),
            rect.position,
            rect.size,
        )
        .map_err(web_err)?;
    Ok(())
}

/// Moves the panel's webview over its slot again, or hides it (while a menu or dialog is
/// open, since a native webview always draws above the page).
#[tauri::command(rename_all = "snake_case")]
async fn web_place(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport: f64,
    hidden: bool,
) -> Result<(), AppError> {
    let Some(web) = app.get_webview(WEB) else {
        return Ok(());
    };
    if hidden {
        return web.hide().map_err(web_err);
    }
    web.set_bounds(web_rect(&app, x, y, width, height, viewport))
        .map_err(web_err)?;
    web.show().map_err(web_err)
}

/// Closes the page, which also stops whatever it was playing.
#[tauri::command(rename_all = "snake_case")]
async fn web_close(app: AppHandle) -> Result<(), AppError> {
    match app.get_webview(WEB) {
        Some(web) => web.close().map_err(web_err),
        None => Ok(()),
    }
}

/// `path` for the path part of a URL: everything but letters, digits, `-._~/` percent-encoded.
fn url_path(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Opens a file at a line in the editor chosen in the settings, through the editor's own URL
/// scheme (works without its command-line tool on PATH). Only the known editors are built here,
/// so this never opens an arbitrary URL.
#[tauri::command(rename_all = "snake_case")]
async fn open_in_editor(app: AppHandle, path: String, line: u32, col: u32) -> Result<(), AppError> {
    let path = abs(&path)?;
    let editor = settings_path(&app)
        .ok()
        .and_then(|p| settings::load(&p).ok())
        .and_then(|s| s.editor)
        .unwrap_or_else(|| "vscode".into());
    let url = format!(
        "{editor}://file{}:{}:{}",
        url_path(&path.to_string_lossy()),
        line.max(1),
        col.max(1)
    );
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg("--")
        .arg(&url)
        .spawn()?;
    Ok(())
}

/// Frontend errors, written to stderr: the release webview has no console to read them from.
#[tauri::command]
async fn log_error(message: String) {
    eprintln!("[tine frontend] {message}");
}

/// Whether macOS gave tine Full Disk Access. Without it, macOS asks separately for Desktop,
/// Documents, Downloads and other protected places. Always true elsewhere.
#[tauri::command]
async fn full_disk_access() -> bool {
    // shortcut: the TCC database is readable only with Full Disk Access; the usual check, as macOS has no API for it.
    !cfg!(target_os = "macos")
        || std::env::var_os("HOME").is_some_and(|home| {
            std::fs::File::open(
                std::path::Path::new(&home)
                    .join("Library/Application Support/com.apple.TCC/TCC.db"),
            )
            .is_ok()
        })
}

/// Opens System Settings at Privacy & Security > Full Disk Access (macOS only).
#[tauri::command]
async fn open_full_disk_access_settings() -> Result<(), AppError> {
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
                    &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
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
            // Off the main thread: with the Docker VM stopped, the docker CLI may be slow to fail.
            if let Some(docker) = sandbox::docker() {
                std::thread::spawn(move || sandbox::sweep(&docker));
            }
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
            open_in_editor,
            settings_set,
            open_full_disk_access_settings,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            fs_list_dir,
            fs_find_files,
            fs_read_file,
            fs_search,
            fs_read_image,
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
            git_branch_base,
            web_show,
            web_place,
            web_close,
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
    use super::{abs, is_openable_url, url_path};

    #[test]
    fn url_path_encodes_everything_but_safe_characters() {
        assert_eq!(
            url_path("/Users/me/my app/a#b?.rs"),
            "/Users/me/my%20app/a%23b%3F.rs"
        );
        assert_eq!(url_path("/ş"), "/%C5%9F");
    }

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
