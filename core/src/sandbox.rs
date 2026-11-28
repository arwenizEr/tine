//! Sandboxed tabs.
//!
//! Restricted: the shell runs under macOS Seatbelt (`sandbox-exec`). Every program it
//! starts inherits the sandbox. It may write only to the tab's folder and the `writable`
//! list, may not read the `deny_read` list, and may not reach launchd, Launch Services,
//! Apple Events, the keychain or local sockets. This guards against accidents and careless
//! tools, not against code built to escape; that is what an isolated tab is for.
//!
//! Isolated: the shell runs as root in a throwaway Linux container (Docker; on macOS inside
//! a VM such as Colima). Only the tab's folder is shared, at /work, and no host environment
//! variables reach it.

use crate::error::AppError;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

pub enum Sandbox {
    Restricted(Policy),
    Isolated(Isolated),
}

#[derive(Debug, Clone)]
pub struct Isolated {
    pub image: String,
    pub network: bool,
}

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

/// Where the tab's folder appears inside an isolated container.
pub const WORK: &str = "/work";
/// Label on every isolated container; its value is the pid of the tine that started it.
const OWNER: &str = "tine.owner";

/// The Docker CLI. Apps started from Finder have no Homebrew PATH, so the usual places too.
pub fn docker() -> Option<PathBuf> {
    let on_path: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join("docker"))
                .collect()
        })
        .unwrap_or_default();
    on_path
        .into_iter()
        .chain(["/opt/homebrew/bin/docker", "/usr/local/bin/docker"].map(PathBuf::from))
        .find(|p| p.is_file())
}

/// `--mount` source and target. Docker splits the value at commas, so a path with one is
/// refused rather than letting it add mount options.
fn bind(src: &Path, dst: &str, readonly: bool) -> Result<String, AppError> {
    let src = src.to_string_lossy();
    if src.contains(',') || src.contains('"') {
        return Err(AppError::new(
            "sandbox",
            format!("an isolated tab cannot share {src}: commas and quotes are not supported"),
        ));
    }
    let ro = if readonly { ",readonly" } else { "" };
    Ok(format!("type=bind,src={src},dst={dst}{ro}"))
}

/// Arguments for `docker` that start an isolated shell for `cwd`, and the container's name.
pub fn isolated_args(
    cwd: &Path,
    home: &Path,
    integration: Option<&Path>,
    iso: &Isolated,
) -> Result<(Vec<String>, String), AppError> {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let cwd = std::fs::canonicalize(cwd)?;
    check_cwd(&cwd, &real(home))?;
    if iso.image.is_empty() || iso.image.starts_with('-') {
        return Err(AppError::new(
            "sandbox",
            format!("not an image name: \"{}\"", iso.image),
        ));
    }
    let pid = std::process::id();
    let name = format!("tine-{pid}-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let mut a: Vec<String> = ["run", "-it", "--rm", "--init", "--name", &name, "--label"]
        .map(String::from)
        .into();
    a.push(format!("{OWNER}={pid}"));
    a.extend([
        "-w".into(),
        WORK.into(),
        "--mount".into(),
        bind(&cwd, WORK, false)?,
    ]);
    // Hooks and config run on the host the next time you use git outside the container.
    for git in [".git/hooks", ".git/config"] {
        if cwd.join(git).exists() {
            a.extend([
                "--mount".into(),
                bind(&cwd.join(git), &format!("{WORK}/{git}"), true)?,
            ]);
        }
    }
    if let Some(dir) = integration {
        a.extend(["--mount".into(), bind(dir, "/tine", true)?]);
    }
    // Named only: each takes its value from the docker CLI's own environment (see pty.rs).
    for var in [
        "TERM",
        "COLORTERM",
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "TINE_TOKEN",
    ] {
        a.extend(["-e".into(), var.into()]);
    }
    a.extend(["-e".into(), "LANG=C.UTF-8".into()]);
    if !iso.network {
        a.extend(["--network".into(), "none".into()]);
    }
    a.push(iso.image.clone());
    match integration {
        Some(_) => a.extend(["bash", "--rcfile", "/tine/integration.bash", "-i"].map(String::from)),
        None => a.extend(["bash", "-l"].map(String::from)),
    }
    Ok((a, name))
}

/// Removes an isolated container. Needed because the docker CLI ignores the SIGHUP that
/// closing a tab sends, and a killed CLI leaves its container running.
pub fn remove(docker: &Path, name: &str) {
    let _ = Command::new(docker)
        .args(["rm", "-f", name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Removes isolated containers left by a tine that is no longer running (it crashed or was
/// killed), so code started in them does not keep running unseen.
pub fn sweep(docker: &Path) {
    let Ok(out) = Command::new(docker)
        .args(["ps", "-a", "--filter", &format!("label={OWNER}")])
        .args([
            "--format",
            &format!("{{{{.Names}}}} {{{{.Label \"{OWNER}\"}}}}"),
        ])
        .stderr(Stdio::null())
        .output()
    else {
        return;
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Some((name, pid)) = line.split_once(' ') else {
            continue;
        };
        // shortcut: a reused pid keeps its old containers; fine until containers outlive reboots.
        let alive = Command::new("/bin/kill")
            .args(["-0", pid])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !alive {
            remove(docker, name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_shares_only_the_folder_and_passes_variables_by_name() {
        let dir = crate::fs::tests::TempDir::new();
        std::fs::create_dir_all(dir.path(".git/hooks")).unwrap();
        let iso = Isolated {
            image: "debian:stable-slim".into(),
            network: false,
        };
        let (a, name) = isolated_args(&dir.0, Path::new("/nonexistent-home"), None, &iso).unwrap();
        let s = a.join(" ");
        assert!(
            s.contains(&format!("type=bind,src={},dst=/work ", dir.0.display())),
            "{s}"
        );
        assert!(s.contains("dst=/work/.git/hooks,readonly"), "{s}");
        assert!(
            !s.contains(".git/config"),
            "a missing file must not be mounted: {s}"
        );
        assert!(s.contains("--network none"), "{s}");
        assert!(s.contains(&format!("--name {name}")));
        assert!(
            !a.iter().any(|x| x.starts_with("TINE_TOKEN=")),
            "values never on the command line"
        );

        let bad = Isolated {
            image: "--privileged".into(),
            network: true,
        };
        assert_eq!(
            isolated_args(&dir.0, Path::new("/x"), None, &bad)
                .unwrap_err()
                .code,
            "sandbox"
        );
        assert_eq!(
            bind(Path::new("/a,readonly=false"), WORK, false)
                .unwrap_err()
                .code,
            "sandbox"
        );
    }

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
