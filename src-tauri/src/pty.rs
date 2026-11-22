use crate::error::AppError;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const FLUSH_BYTES: usize = 64 * 1024;

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

type Sessions = Arc<Mutex<HashMap<u32, Arc<Session>>>>;

const ZSH_INTEGRATION: &str = include_str!("../../shell-integration/integration.zsh");
const BASH_INTEGRATION: &str = include_str!("../../shell-integration/integration.bash");

/// Writes the shell integration scripts into `dir`: zsh needs its file named `.zshenv`
/// inside the folder that becomes ZDOTDIR.
pub fn install_shell_integration(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(".zshenv"), ZSH_INTEGRATION)?;
    std::fs::write(dir.join("integration.bash"), BASH_INTEGRATION)
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Sessions,
    next_id: AtomicU32,
    /// Folder from `install_shell_integration`; `None` starts plain login shells.
    integration_dir: Option<PathBuf>,
}

fn default_shell() -> String {
    match std::env::var("SHELL") {
        Ok(s) if !s.is_empty() => s,
        _ if cfg!(target_os = "macos") => "/bin/zsh".into(),
        _ => "/bin/bash".into(),
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl PtyManager {
    pub fn new(integration_dir: Option<PathBuf>) -> Self {
        Self {
            integration_dir,
            ..Self::default()
        }
    }

    /// Starts the user's login shell. `on_data` receives output batched to at most
    /// every 8 ms or 64 KB; `on_exit` runs once, after the last output, with the exit code.
    pub fn spawn(
        &self,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        on_data: impl FnMut(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(u32, Option<i32>) + Send + 'static,
    ) -> Result<u32, AppError> {
        self.spawn_shell(&default_shell(), cwd, cols, rows, on_data, on_exit)
    }

    fn spawn_shell(
        &self,
        shell: &str,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        mut on_data: impl FnMut(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(u32, Option<i32>) + Send + 'static,
    ) -> Result<u32, AppError> {
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(AppError::io)?;

        let mut cmd = CommandBuilder::new(shell);
        // Always a login shell (bash emulates it in its integration script): apps started
        // from Finder get a minimal environment otherwise. Integration never edits dotfiles.
        let name = Path::new(shell)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        match (&self.integration_dir, name) {
            (Some(dir), "zsh") => {
                cmd.arg("-l");
                match std::env::var_os("ZDOTDIR") {
                    Some(user) => cmd.env("TINE_USER_ZDOTDIR", user),
                    None => cmd.env_remove("TINE_USER_ZDOTDIR"),
                }
                cmd.env("ZDOTDIR", dir);
            }
            (Some(dir), "bash") => {
                cmd.arg("--rcfile");
                cmd.arg(dir.join("integration.bash"));
                cmd.arg("-i");
            }
            _ => cmd.arg("-l"),
        }
        if let Some(dir) = cwd.or_else(|| std::env::var("HOME").ok()) {
            cmd.cwd(dir);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", env!("CARGO_PKG_NAME"));
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        // Finder-launched apps have no LANG; without a UTF-8 locale shells mangle Unicode.
        if std::env::var_os("LANG").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(AppError::io)?;
        // The slave must be closed here, or the reader never sees EOF when the shell exits.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(AppError::io)?;
        let writer = pair.master.take_writer().map_err(AppError::io)?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let session = Session {
            killer: Mutex::new(child.clone_killer()),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
        };
        self.sessions.lock().unwrap().insert(id, Arc::new(session));

        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            let mut buf = vec![0u8; FLUSH_BYTES];
            // Raw bytes only: UTF-8 sequences split across reads are decoded by xterm.js.
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });

        let sessions = self.sessions.clone();
        thread::spawn(move || {
            while let Ok(mut batch) = rx.recv() {
                let deadline = Instant::now() + FLUSH_INTERVAL;
                while batch.len() < FLUSH_BYTES {
                    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(more) => batch.extend_from_slice(&more),
                        Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
                    }
                }
                on_data(batch);
            }
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            sessions.lock().unwrap().remove(&id);
            on_exit(id, code);
        });

        Ok(id)
    }

    fn get(&self, id: u32) -> Result<Arc<Session>, AppError> {
        self.sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::new("not_found", format!("no pty {id}")))
    }

    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), AppError> {
        let session = self.get(id)?;
        let mut w = session.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), AppError> {
        self.get(id)?
            .master
            .lock()
            .unwrap()
            .resize(size(cols, rows))
            .map_err(AppError::io)
    }

    pub fn kill(&self, id: u32) -> Result<(), AppError> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .remove(&id)
            .ok_or_else(|| AppError::new("not_found", format!("no pty {id}")))?;
        // Dropping the session afterwards closes the master, which hangs up the foreground job too.
        session.killer.lock().unwrap().kill()?;
        Ok(())
    }

    pub fn kill_all(&self) {
        let ids: Vec<u32> = self.sessions.lock().unwrap().keys().copied().collect();
        for id in ids {
            let _ = self.kill(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;

    struct Spawned {
        mgr: PtyManager,
        id: u32,
        out: Receiver<Vec<u8>>,
        exit: Receiver<Option<i32>>,
    }

    fn spawn() -> Spawned {
        let mgr = PtyManager::default();
        let (out_tx, out) = mpsc::channel();
        let (exit_tx, exit) = mpsc::channel();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let id = mgr
            .spawn(
                Some(cwd),
                80,
                24,
                move |b| {
                    let _ = out_tx.send(b);
                },
                move |_, c| {
                    let _ = exit_tx.send(c);
                },
            )
            .expect("spawn");
        Spawned { mgr, id, out, exit }
    }

    /// Reads output until `needle` appears; the echoed command line is excluded by
    /// building the expected text with shell arithmetic.
    fn wait_for(out: &Receiver<Vec<u8>>, needle: &str) -> String {
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Ok(b) = out.recv_timeout(Duration::from_millis(200)) {
                seen.extend(b);
                let text = String::from_utf8_lossy(&seen);
                if text.contains(needle) {
                    return text.into_owned();
                }
            }
        }
        panic!(
            "timed out waiting for {needle:?}; got {:?}",
            String::from_utf8_lossy(&seen)
        );
    }

    #[test]
    fn spawn_and_write_round_trip() {
        let s = spawn();
        s.mgr.write(s.id, b"echo tine_$((40+2))\r").unwrap();
        wait_for(&s.out, "tine_42");
        s.mgr.kill(s.id).unwrap();
    }

    #[test]
    fn shell_has_terminal_env() {
        let s = spawn();
        s.mgr
            .write(s.id, b"echo \"T=$TERM C=$COLORTERM\"_$((1+1))\r")
            .unwrap();
        wait_for(&s.out, "T=xterm-256color C=truecolor_2");
        s.mgr.kill(s.id).unwrap();
    }

    #[test]
    fn resize_changes_tty_size() {
        let s = spawn();
        s.mgr.resize(s.id, 100, 40).unwrap();
        s.mgr.write(s.id, b"stty size\r").unwrap();
        wait_for(&s.out, "40 100");
        s.mgr.kill(s.id).unwrap();
    }

    #[test]
    fn shell_exit_reports_code_and_removes_session() {
        let s = spawn();
        s.mgr.write(s.id, b"exit 3\r").unwrap();
        let code = s
            .exit
            .recv_timeout(Duration::from_secs(15))
            .expect("exit callback");
        assert_eq!(code, Some(3));
        assert_eq!(s.mgr.write(s.id, b"x").unwrap_err().code, "not_found");
    }

    fn osc7_reported_by(shell: &str) {
        if !Path::new(shell).exists() {
            eprintln!("skipping: {shell} not installed");
            return;
        }
        let dir = crate::fs::tests::TempDir::new();
        install_shell_integration(&dir.0).unwrap();
        let mgr = PtyManager::new(Some(dir.0.clone()));
        let (tx, out) = mpsc::channel();
        let id = mgr
            .spawn_shell(
                shell,
                None,
                80,
                24,
                move |b| {
                    let _ = tx.send(b);
                },
                |_, _| {},
            )
            .unwrap();
        mgr.write(id, b"cd /usr\r").unwrap();
        let text = wait_for(&out, "/usr\x1b\\");
        assert!(text.contains("\x1b]7;file://"), "no OSC 7 in {text:?}");
        assert!(text.contains("\x1b]133;A\x07"), "no prompt mark in {text:?}");

        // A failing command: its text, the start mark, then the end mark with exit code 3.
        mgr.write(id, b"(exit 3)\r").unwrap();
        let text = wait_for(&out, "\x1b]133;D;3\x07");
        assert!(text.contains("\x1b]633;E;(exit 3)\x07\x1b]133;C\x07"), "no command marks in {text:?}");
        mgr.kill(id).unwrap();
    }

    #[test]
    fn zsh_integration_reports_cwd() {
        osc7_reported_by("/bin/zsh");
    }

    #[test]
    fn bash_integration_reports_cwd() {
        osc7_reported_by("/bin/bash");
    }

    #[test]
    fn kill_ends_shell_and_forgets_it() {
        let s = spawn();
        s.mgr.kill(s.id).unwrap();
        s.exit
            .recv_timeout(Duration::from_secs(15))
            .expect("exit callback after kill");
        assert_eq!(s.mgr.write(s.id, b"x").unwrap_err().code, "not_found");
        assert_eq!(s.mgr.resize(s.id, 10, 10).unwrap_err().code, "not_found");
        assert_eq!(s.mgr.kill(s.id).unwrap_err().code, "not_found");
    }
}
