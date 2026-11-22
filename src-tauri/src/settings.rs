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
    /// Action name -> key chord such as "cmd+t" or "ctrl+shift+t".
    pub keybindings: BTreeMap<String, String>,
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

# Shortcuts. Modifiers: cmd, ctrl, alt, shift. Keys: a letter, a digit, up, down.
# Actions: newTab, closeTab, clear, toggleSidebar, toggleViewer, newFile, openFolder,
#          find, palette, copy, paste, prevBlock, nextBlock
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
    let settings: Settings =
        toml::from_str(&text).map_err(|e| AppError::new("invalid_settings", e.message()))?;
    if let Some(theme) = &settings.theme
        && !["system", "light", "dark"].contains(&theme.as_str())
    {
        return Err(AppError::new(
            "invalid_settings",
            format!("theme must be system, light or dark, not \"{theme}\""),
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
    fn rejects_bad_values_with_a_readable_message() {
        let t = TempDir::new();
        let path = t.path("settings.toml");
        for bad in [
            "theme = \"blue\"",
            "font_size = 200",
            "fontsize = 12",
            "font_size = \"big\"",
        ] {
            std::fs::write(&path, bad).unwrap();
            let err = load(&path).unwrap_err();
            assert_eq!(err.code, "invalid_settings", "{bad}");
            assert!(!err.message.is_empty());
        }
    }
}
