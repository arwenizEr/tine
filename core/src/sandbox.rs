//! Restricted tabs: the shell runs under macOS Seatbelt (`sandbox-exec`). Every program it
//! starts inherits the sandbox. It may write only to the tab's folder and the `writable`
//! list, may not read the `deny_read` list, and may not reach launchd, Launch Services,
//! Apple Events, the keychain or local sockets. This guards against accidents and careless
//! tools, not against code built to escape; that is what an isolated (VM) tab is for.

use crate::error::AppError;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, symlink};
use std::path::{Component, Path, PathBuf};

pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// What a restricted shell may touch. Paths need not exist.
#[derive(Debug, Clone, Default)]
pub struct Policy {
    /// Writable besides the tab's folder: temp folders, package caches.
    pub writable: Vec<PathBuf>,
    pub deny_read: Vec<PathBuf>,
    /// Never writable, even inside a writable folder: tine's settings and shell integration.
    pub deny_write: Vec<PathBuf>,
    pub network: bool,
    /// Set in the shell's environment.
    pub env: Vec<(String, OsString)>,
}

/// Folders a restricted tab may not start in: writing there could change what runs outside
/// the sandbox (dotfiles, ~/.config, LaunchAgents) or would make the sandbox pointless.
fn check_cwd(cwd: &Path, home: &Path) -> Result<(), AppError> {
    let refuse = |why: &str| {
        Err(AppError::new(
            "sandbox",
            format!("a restricted tab cannot start in {}: {why}", cwd.display()),
        ))
    };
    if home.starts_with(cwd) {
        return refuse("it holds your home folder");
    }
    if let Ok(rest) = cwd.strip_prefix(home)
        && let Some(Component::Normal(first)) = rest.components().next()
    {
        let first = first.to_string_lossy();
        if first.starts_with('.') || first == "Library" {
            return refuse("programs outside the sandbox read their settings from there");
        }
    }
    Ok(())
}

/// Escapes `s` for a POSIX extended regex, the kind Seatbelt's `regex` filter takes.
fn regex_escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            let special = "\\.^$|?*+()[]{}".contains(c);
            special.then_some('\\').into_iter().chain([c])
        })
        .collect()
}

/// Real paths, because Seatbelt matches resolved ones (/tmp is /private/tmp on macOS).
/// A missing path resolves its nearest existing parent.
fn real(p: &Path) -> PathBuf {
    if let Ok(r) = std::fs::canonicalize(p) {
        return r;
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => real(parent).join(name),
        _ => p.to_path_buf(),
    }
}

/// The Seatbelt profile plus its parameters. Paths reach the profile only as `-D`
/// parameters, never as profile text, so a folder name cannot add rules.
fn profile(policy: &Policy) -> (String, Vec<(String, PathBuf)>) {
    let mut params = Vec::new();
    let mut list = |prefix: &str, paths: &[PathBuf], rule: &str| {
        let filters: String = paths
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let name = format!("{prefix}{i}");
                params.push((name.clone(), real(p)));
                format!(" ({rule} (param \"{name}\"))")
            })
            .collect();
        filters
    };
    let writable = list("W", &policy.writable, "subpath");
    let deny_write = list("P", &policy.deny_write, "subpath");
    let deny_read = list("R", &policy.deny_read, "subpath");

    // Later rules win in Seatbelt, so each deny comes after the allow it narrows.
    let mut p = String::from("(version 1)\n(allow default)\n(deny file-write*)\n");
    p += &format!(
        "(allow file-write* (subpath (param \"CWD\")){writable}\n  \
         (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/tty\") \
         (literal \"/dev/ptmx\") (literal \"/dev/dtracehelper\") (subpath \"/dev/fd\")\n  \
         (regex #\"^/dev/ttys[0-9]+$\") (regex (param \"HISTORY\")))\n"
    );
    // Git hooks and config run on the host the next time you use git outside the sandbox.
    p += &format!(
        "(deny file-write* (regex #\"/\\.git/hooks(/|$)\") (regex #\"/\\.git/config$\"){deny_write})\n"
    );
    if !deny_read.is_empty() {
        p += &format!("(deny file-read*{deny_read})\n");
    }
    // Ways to get a program outside the sandbox to act for this one.
    p += "(deny process-exec (literal \"/usr/bin/open\") (literal \"/usr/bin/osascript\") \
          (literal \"/usr/bin/osacompile\") (literal \"/usr/bin/security\") (literal \"/bin/launchctl\"))\n\
          (deny appleevent-send)\n\
          (deny mach-lookup (global-name \"com.apple.coreservices.launchservicesd\") \
          (global-name \"com.apple.SecurityServer\"))\n";
    if policy.network {
        // Local sockets reach the Docker daemon, ssh-agent and the like; DNS still needs one.
        p += "(deny network-outbound (remote unix-socket))\n\
              (allow network-outbound (remote unix-socket (path-literal \"/private/var/run/mDNSResponder\")))\n";
    } else {
        p += "(deny network*)\n";
    }
    (p, params)
}

/// Arguments for `sandbox-exec` that run what follows them under `policy` in `cwd`.
pub fn args(cwd: &Path, home: &Path, policy: &Policy) -> Result<Vec<OsString>, AppError> {
    if !cfg!(target_os = "macos") {
        return Err(AppError::new(
            "sandbox",
            "restricted tabs need macOS for now",
        ));
    }
    let cwd = std::fs::canonicalize(cwd)?;
    let home = real(home);
    check_cwd(&cwd, &home)?;
    let (profile, mut params) = profile(policy);
    params.push(("CWD".into(), cwd));
    let history = format!(
        "^{}/\\.(zsh|bash)_history",
        regex_escape(&home.to_string_lossy())
    );
    let mut out: Vec<OsString> = vec!["-D".into(), format!("HISTORY={history}").into()];
    for (name, path) in params {
        let mut d = OsString::from(format!("{name}="));
        d.push(path);
        out.extend(["-D".into(), d]);
    }
    out.extend(["-p".into(), profile.into()]);
    Ok(out)
}

/// Entries of ~/.claude that Claude Code writes while it runs; a restricted tab keeps its own.
const CLAUDE_STATE: [&str; 19] = [
    "backups",
    "cache",
    "debug",
    "downloads",
    "file-history",
    "history.jsonl",
    "ide",
    "logs",
    "mcp-needs-auth-cache.json",
    "paste-cache",
    "plans",
    "projects",
    "session-env",
    "sessions",
    "shell-snapshots",
    "state",
    "statsig",
    "telemetry",
    "todos",
];

/// Fills `dir`, Claude Code's config folder in restricted tabs, from the user's own, so
/// settings, hooks, MCP servers, plugins and skills work there too. Config entries become
/// links into ~/.claude, which the sandbox can read but not change; state entries and
/// dotfiles stay the sandbox's own. ~/.claude.json is copied afresh, so changes made in the
/// sandbox never reach the real one.
///
/// Runs outside the sandbox on a folder the sandbox can write, so it never writes through
/// anything found there: entries are removed, not opened, before being replaced.
pub fn prepare_claude(dir: &Path, home: &Path) -> io::Result<()> {
    mirror(&home.join(".claude"), dir, &CLAUDE_STATE)?;
    // Plugin code stays read-only (its hooks run on the host too); plugins keep state in store.
    mirror(
        &home.join(".claude/plugins"),
        &dir.join("plugins"),
        &["store"],
    )?;
    match fs::read(home.join(".claude.json")) {
        Ok(bytes) => {
            let tmp = dir.join(".claude.json.tine");
            remove(&tmp)?;
            // create_new refuses an existing path, a planted link included.
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?
                .write_all(&bytes)?;
            // rename replaces whatever is at the destination, never what a link points to.
            fs::rename(&tmp, dir.join(".claude.json"))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Makes `dir` a real folder holding a link to each entry of `real`, except dotfiles and
/// `own` (left to the sandbox) and "plugins" (mirrored on its own).
fn mirror(real: &Path, dir: &Path, own: &[&str]) -> io::Result<()> {
    if fs::symlink_metadata(dir).is_ok_and(|m| !m.is_dir()) {
        remove(dir)?;
    }
    fs::create_dir_all(dir)?;
    for entry in fs::read_dir(real).into_iter().flatten().flatten() {
        let name = entry.file_name();
        let text = name.to_string_lossy();
        if text.starts_with('.') || text == "plugins" || own.contains(&text.as_ref()) {
            continue;
        }
        let (link, target) = (dir.join(&name), real.join(&name));
        if fs::read_link(&link).is_ok_and(|t| t == target) {
            continue;
        }
        remove(&link)?;
        symlink(&target, &link)?;
    }
    Ok(())
}

/// Removes a file, link or folder; a link is removed itself, never followed.
fn remove(p: &Path) -> io::Result<()> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(p),
        Ok(_) => fs::remove_file(p),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_home_its_parents_and_config_folders() {
        let home = Path::new("/Users/a");
        for bad in [
            "/",
            "/Users",
            "/Users/a",
            "/Users/a/.config/x",
            "/Users/a/Library/LaunchAgents",
        ] {
            assert_eq!(
                check_cwd(Path::new(bad), home).unwrap_err().code,
                "sandbox",
                "{bad}"
            );
        }
        for ok in [
            "/Users/a/projects/x",
            "/Users/a/Library-notes",
            "/tmp/x",
            "/Users/b",
        ] {
            check_cwd(Path::new(ok), home).unwrap();
        }
    }

    #[test]
    fn claude_config_is_linked_read_only_and_state_stays_separate() {
        use crate::fs::tests::TempDir;
        let (home, dir, victim) = (TempDir::new(), TempDir::new(), TempDir::new());
        fs::create_dir_all(home.path(".claude/skills")).unwrap();
        fs::create_dir_all(home.path(".claude/projects")).unwrap();
        fs::create_dir_all(home.path(".claude/plugins/cache")).unwrap();
        fs::create_dir_all(home.path(".claude/plugins/store")).unwrap();
        fs::write(home.path(".claude/settings.json"), "{}").unwrap();
        fs::write(home.path(".claude/.flag"), "").unwrap();
        fs::write(home.path(".claude.json"), "{\"mcpServers\":{}}").unwrap();
        // The sandbox planted links, hoping tine writes through them.
        fs::write(victim.path("zshrc"), "mine").unwrap();
        symlink(victim.path("zshrc"), dir.path(".claude.json")).unwrap();
        symlink(victim.path("zshrc"), dir.path("settings.json")).unwrap();
        fs::create_dir_all(dir.path("skills")).unwrap();

        prepare_claude(&dir.0, &home.0).unwrap();
        prepare_claude(&dir.0, &home.0).unwrap(); // again: links already in place

        assert_eq!(fs::read_to_string(victim.path("zshrc")).unwrap(), "mine");
        assert_eq!(
            fs::read_link(dir.path("settings.json")).unwrap(),
            home.path(".claude/settings.json")
        );
        assert_eq!(
            fs::read_link(dir.path("skills")).unwrap(),
            home.path(".claude/skills")
        );
        assert!(
            fs::symlink_metadata(dir.path(".claude.json"))
                .unwrap()
                .is_file()
        );
        assert_eq!(
            fs::read_to_string(dir.path(".claude.json")).unwrap(),
            "{\"mcpServers\":{}}"
        );
        assert!(!dir.path("projects").exists() && !dir.path(".flag").exists());
        assert!(fs::symlink_metadata(dir.path("plugins")).unwrap().is_dir());
        assert_eq!(
            fs::read_link(dir.path("plugins/cache")).unwrap(),
            home.path(".claude/plugins/cache")
        );
        assert!(!dir.path("plugins/store").exists());
    }

    #[test]
    fn regex_escape_quotes_metacharacters() {
        assert_eq!(regex_escape("/Users/a.b (1)"), "/Users/a\\.b \\(1\\)");
    }

    #[test]
    fn paths_reach_the_profile_only_as_parameters() {
        let evil = PathBuf::from("/tmp/x\") (allow file-write* (subpath \"/");
        let policy = Policy {
            writable: vec![evil.clone()],
            deny_read: vec![],
            deny_write: vec![],
            network: true,
            env: vec![],
        };
        let (text, params) = profile(&policy);
        assert!(!text.contains("/tmp/x"), "{text}");
        assert!(
            !text.contains("(deny file-read*"),
            "an empty deny list must not deny every read"
        );
        assert_eq!(params, vec![("W0".to_string(), real(&evil))]);
    }
}
