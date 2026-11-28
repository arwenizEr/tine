use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// User settings from one TOML file. Every field is optional; missing ones keep the defaults.
#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub font_family: Option<String>,
    pub font_size: Option<f64>,
    /// "system" (follow macOS / the desktop), "light" or "dark".
    pub theme: Option<String>,
    /// Shell for new tabs; defaults to $SHELL.
    pub shell: Option<String>,
    /// Editor for "Open in Editor": "vscode" (default), "cursor" or "zed".
    pub editor: Option<String>,
    /// Web pages offered in the web panel's bookmark menu (http or https addresses).
    pub bookmarks: Vec<String>,
    /// Action name -> key chord such as "cmd+t" or "ctrl+shift+t".
    pub keybindings: BTreeMap<String, String>,
    pub sandbox: Sandbox,
    pub caio: Caio,
}

/// CompactAIO, the local docs server (see caio.rs).
#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Caio {
    /// The CompactAIO checkout, where `npm run setup` was run.
    pub path: Option<String>,
}

/// Restricted tabs. Paths are absolute or start with `~/`. `deny_read` adds to
/// SANDBOX_DENY_READ and `shared` to SANDBOX_SHARED.
#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Sandbox {
    pub network: Option<bool>,
    /// Local TCP ports a restricted tab may reach with the network off.
    pub local_ports: Vec<u16>,
    /// Image for isolated tabs; it needs bash.
    pub image: Option<String>,
    /// Isolated tabs keep what was installed in them, per folder.
    pub keep: Option<bool>,
    /// Lets tools use your keys: the keychain, ssh-agent and SANDBOX_DENY_READ.
    pub secrets: Option<bool>,
    /// Real folders writable besides the tab's own.
    pub writable: Vec<String>,
    pub deny_read: Vec<String>,
    /// Hidden home entries linked read-only into the private home instead of copied.
    pub shared: Vec<String>,
    /// Folders whose tabs always open restricted, whatever opens them.
    pub folders: Vec<String>,
}

pub const SANDBOX_IMAGE: &str = "debian:stable-slim";

/// Big toolchains, linked read-only into the private home: they work as they are.
pub const SANDBOX_SHARED: [&str; 2] = [".rustup", ".nvm"];

/// Secrets a restricted tab may not read unless `secrets` is on; also VM folders, whose
/// keys and sockets control Docker.
pub const SANDBOX_DENY_READ: [&str; 21] = [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.netrc",
    "~/.git-credentials",
    "~/.npmrc",
    "~/.pypirc",
    "~/.docker",
    "~/.kube",
    "~/.azure",
    "~/.config/gh",
    "~/.config/gcloud",
    "~/.config/git/credentials",
    "~/.cargo/credentials.toml",
    "~/Library/Keychains",
    "~/Library/Cookies",
    "~/Library/Application Support/Google/Chrome",
    "~/Library/Application Support/Firefox",
    "~/.colima",
    "~/.lima",
    "~/.orbstack",
];

/// `~/x` to `<home>/x`; other paths unchanged.
pub fn expand_home(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

#[derive(Serialize, Debug)]
pub struct Loaded {
    pub path: String,
    pub settings: Settings,
}

/// Written on first start so the options are discoverable; everything is commented out.
const TEMPLATE: &str = r#"# tine settings. Saved changes apply at once; delete a line to go back to the default.

# font_family = "SF Mono, Menlo, monospace"
# font_size = 13

# "system" follows the light or dark appearance of your desktop.
# theme = "system"   # or "light", "dark"

# Shell for new tabs. Default: your login shell ($SHELL).
# shell = "/bin/zsh"

# Editor for "Open in Editor": "vscode", "cursor" or "zed".
# editor = "vscode"

# Bookmarks for the web panel (◫ Web); the panel's ☆ button adds to this list.
# bookmarks = ["https://www.youtube.com/"]

# Sandboxed tabs. Restricted: the shell writes only to its folder and a private copy of
# your home's dotfiles, so every tool keeps working without changing the real ones.
# Isolated: the shell runs as root in a Docker container that sees only its folder.
# [sandbox]
# network = true
# local_ports = [3920]       # restricted tabs reach these on localhost even with network off
# image = "debian:stable-slim"  # isolated tabs; needs bash
# keep = false               # true: isolated tabs keep what you install, per folder
# secrets = false            # true: tools may use the keychain, ssh-agent, ~/.ssh, ~/.aws, ...
# writable = []              # real folders writable besides the tab's
# deny_read = ["~/secrets"]  # unreadable on top of the built-in list
# shared = [".rustup", ".nvm"]  # added to these: linked read-only instead of copied
# folders = ["~/untrusted"]  # tabs opened here are always restricted

# CompactAIO: local, version-aware API docs for you (Search Docs, Check Symbol) and your
# agents (Connect Caio to Agents). Restricted tabs can reach it even with network off.
# [caio]
# path = "~/projects/compactaio"

# Shortcuts. Modifiers: cmd, ctrl, alt, shift. Keys: a letter, a digit, up, down.
# Actions: newTab, closeTab, clear, toggleSidebar, toggleViewer, newFile, openFolder,
#          find, palette, copy, paste, prevBlock, nextBlock, sendSelection, split, settings,
#          search
[keybindings]
# newTab = "cmd+t"
# palette = "cmd+p"
"#;

/// `~/.config/<app>/settings.toml` on both macOS and Linux, where terminal users expect it.
pub fn default_path(app: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join(".config")
            .join(app)
            .join("settings.toml"),
    )
}

/// Reads the settings, creating the commented template if the file does not exist yet.
pub fn load(path: &Path) -> Result<Settings, AppError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(path, TEMPLATE)?;
            TEMPLATE.to_string()
        }
        Err(e) => return Err(e.into()),
    };
    parse(&text)
}

fn parse(text: &str) -> Result<Settings, AppError> {
    let settings: Settings =
        toml::from_str(text).map_err(|e| AppError::new("invalid_settings", e.message()))?;
    if let Some(theme) = &settings.theme
        && !["system", "light", "dark"].contains(&theme.as_str())
    {
        return Err(AppError::new(
            "invalid_settings",
            format!("theme must be system, light or dark, not \"{theme}\""),
        ));
    }
    if let Some(editor) = &settings.editor
        && !EDITORS.contains(&editor.as_str())
    {
        return Err(AppError::new(
            "invalid_settings",
            format!("editor must be vscode, cursor or zed, not \"{editor}\""),
        ));
    }
    if let Some(bad) = settings
        .bookmarks
        .iter()
        .find(|b| !(b.starts_with("https://") || b.starts_with("http://")))
    {
        return Err(AppError::new(
            "invalid_settings",
            format!("bookmarks must be http or https addresses, not \"{bad}\""),
        ));
    }
    if let Some(bad) = settings
        .sandbox
        .writable
        .iter()
        .chain(&settings.sandbox.deny_read)
        .chain(&settings.sandbox.folders)
        .find(|p| !(p.starts_with('/') || p.starts_with("~/")))
    {
        return Err(AppError::new(
            "invalid_settings",
            format!("sandbox paths must start with / or ~/, not \"{bad}\""),
        ));
    }
    if let Some(image) = &settings.sandbox.image
        && (image.is_empty() || image.starts_with('-') || image.contains(char::is_whitespace))
    {
        return Err(AppError::new(
            "invalid_settings",
            format!("sandbox.image must be an image name, not \"{image}\""),
        ));
    }
    if let Some(p) = &settings.caio.path
        && !(p.starts_with('/') || p.starts_with("~/"))
    {
        return Err(AppError::new(
            "invalid_settings",
            format!("caio.path must start with / or ~/, not \"{p}\""),
        ));
    }
    if settings.sandbox.local_ports.contains(&0) {
        return Err(AppError::new(
            "invalid_settings",
            "sandbox.local_ports cannot hold 0",
        ));
    }
    if let Some(size) = settings.font_size
        && !(6.0..=72.0).contains(&size)
    {
        return Err(AppError::new(
            "invalid_settings",
            format!("font_size must be between 6 and 72, not {size}"),
        ));
    }
    Ok(settings)
}

/// Top-level keys the settings window may change; keybindings stay a file-only setting.
const EDITABLE: [&str; 6] = [
    "font_family",
    "font_size",
    "theme",
    "shell",
    "editor",
    "bookmarks",
];

/// Editors "Open in Editor" can hand a file to; each opens `<name>://file/<path>:<line>:<col>`.
pub const EDITORS: [&str; 3] = ["vscode", "cursor", "zed"];

/// Sets one top-level setting in the file, or comments it out (back to the default) when
/// `value` is None. Edits the line in place so the user's comments and layout survive, and
/// refuses a result that would not load.
pub fn set(path: &Path, key: &str, value: Option<&toml::Value>) -> Result<Settings, AppError> {
    if !EDITABLE.contains(&key) {
        return Err(AppError::new(
            "invalid",
            format!("{key} cannot be set here"),
        ));
    }
    load(path)?; // creates the template on first use
    let text = std::fs::read_to_string(path)?;
    let next = set_line(&text, key, value.map(|v| format!("{key} = {v}")));
    let settings = parse(&next)?;
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, &next)?;
    std::fs::rename(&tmp, path)?;
    Ok(settings)
}

/// Replaces `key`'s line in the top-level table (before the first `[table]`), preferring an
/// active line over a commented-out one. None comments the active line out.
fn set_line(text: &str, key: &str, line: Option<String>) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let top = lines
        .iter()
        .position(|l| l.trim_start().starts_with('['))
        .unwrap_or(lines.len());
    let assigns = |l: &str, commented: bool| {
        let l = l.trim_start();
        let l = if commented {
            match l.strip_prefix('#') {
                Some(rest) => rest.trim_start(),
                None => return false,
            }
        } else {
            l
        };
        l.strip_prefix(key)
            .is_some_and(|rest| rest.trim_start().starts_with('='))
    };
    let active = (0..top).find(|&i| assigns(&lines[i], false));
    let commented = (0..top).find(|&i| assigns(&lines[i], true));
    match (line, active, commented) {
        (Some(new), Some(i), _) | (Some(new), None, Some(i)) => lines[i] = new,
        (Some(new), None, None) => lines.insert(top, new),
        (None, Some(i), _) => lines[i] = format!("# {}", lines[i].trim_start()),
        (None, None, _) => {}
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::tests::TempDir;

    #[test]
    fn first_load_writes_a_template_that_parses_to_defaults() {
        let t = TempDir::new();
        let path = t.path("cfg/settings.toml");
        assert_eq!(load(&path).unwrap(), Settings::default());
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("# theme = \"system\"")
        );
    }

    #[test]
    fn reads_values_and_keybindings() {
        let t = TempDir::new();
        let path = t.path("settings.toml");
        std::fs::write(
            &path,
            "font_size = 15\ntheme = \"light\"\n[keybindings]\nnewTab = \"cmd+shift+n\"\n",
        )
        .unwrap();
        let s = load(&path).unwrap();
        assert_eq!(s.font_size, Some(15.0));
        assert_eq!(s.theme.as_deref(), Some("light"));
        assert_eq!(
            s.keybindings.get("newTab").map(String::as_str),
            Some("cmd+shift+n")
        );
    }

    #[test]
    fn set_edits_in_place_and_keeps_comments_and_keybindings() {
        let t = TempDir::new();
        let path = t.path("settings.toml");
        load(&path).unwrap(); // template
        let s = set(&path, "theme", Some(&toml::Value::String("light".into()))).unwrap();
        assert_eq!(s.theme.as_deref(), Some("light"));
        set(&path, "font_size", Some(&toml::Value::Integer(15))).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("theme = \"light\"") && !text.contains("# theme = \"system\""));
        assert!(text.contains("font_size = 15") && text.contains("# newTab = \"cmd+t\""));
        assert_eq!(text.matches("theme =").count(), 1);

        // Back to the default: the line is commented out, not deleted.
        let s = set(&path, "theme", None).unwrap();
        assert_eq!(s.theme, None);
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("# theme = \"light\"")
        );

        // A key the file has never mentioned goes above the first table.
        std::fs::write(&path, "[keybindings]\nnewTab = \"cmd+t\"\n").unwrap();
        set(
            &path,
            "shell",
            Some(&toml::Value::String("/bin/bash".into())),
        )
        .unwrap();
        let list = toml::Value::Array(vec![toml::Value::String("https://a.b/".into())]);
        set(&path, "bookmarks", Some(&list)).unwrap();
        let s = load(&path).unwrap();
        assert_eq!(s.bookmarks, ["https://a.b/"]);
        assert_eq!(s.shell.as_deref(), Some("/bin/bash"));
        assert_eq!(s.keybindings.len(), 1);
    }

    #[test]
    fn set_refuses_bad_values_and_unknown_keys_without_writing() {
        let t = TempDir::new();
        let path = t.path("settings.toml");
        std::fs::write(&path, "font_size = 14\n").unwrap();
        assert!(set(&path, "font_size", Some(&toml::Value::Integer(500))).is_err());
        assert!(set(&path, "keybindings", None).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "font_size = 14\n");
    }

    #[test]
    fn rejects_bad_values_with_a_readable_message() {
        let t = TempDir::new();
        let path = t.path("settings.toml");
        for bad in [
            "theme = \"blue\"",
            "font_size = 200",
            "fontsize = 12",
            "font_size = \"big\"",
            "bookmarks = [\"file:///etc/passwd\"]",
            "[sandbox]\nwritable = [\"relative/dir\"]",
            "[sandbox]\ndeny_read = [\"~user/x\"]",
            "[sandbox]\nnetwork = \"off\"",
            "[sandbox]\nlocal_ports = [0]",
            "[caio]\npath = \"projects/compactaio\"",
            "[sandbox]\nlocal_ports = [70000]",
            "[sandbox]\nimage = \"--privileged\"",
        ] {
            std::fs::write(&path, bad).unwrap();
            let err = load(&path).unwrap_err();
            assert_eq!(err.code, "invalid_settings", "{bad}");
            assert!(!err.message.is_empty());
        }
    }
}
