//! CompactAIO ("Caio"): a self-hosted MCP server with version-aware API docs. tine finds it
//! from `[caio] path`, starts it, connects the agents in its tabs to it and asks it questions
//! for the viewer. It is only ever reached on 127.0.0.1; nothing leaves the machine.

use crate::error::AppError;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// The port docker-compose.yml publishes the server on.
pub const PORT: u16 = 3920;
/// The tools tine may call; Caio has no others.
const TOOLS: [&str; 3] = ["search_docs", "check_symbol", "get_endpoint"];

pub struct Caio {
    pub dir: PathBuf,
    token: String,
}

impl Caio {
    /// Reads the token from the checkout's `.env`, which `npm run setup` writes.
    pub fn load(dir: &Path) -> Result<Self, AppError> {
        let env = std::fs::read_to_string(dir.join(".env")).map_err(|e| {
            AppError::new(
                "caio",
                format!(
                    "no .env in {}; run npm run setup there ({e})",
                    dir.display()
                ),
            )
        })?;
        let token = env
            .lines()
            .find_map(|l| l.trim().strip_prefix("CAIO_HTTP_TOKEN="))
            .map(|t| t.trim().trim_matches('"').to_string())
            .filter(|t| !t.is_empty())
            .ok_or_else(|| AppError::new("caio", "CAIO_HTTP_TOKEN is not set in .env"))?;
        Ok(Self {
            dir: dir.to_path_buf(),
            token,
        })
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{PORT}/mcp")
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn up(&self) -> bool {
        http("GET", "/health", None, "").is_ok_and(|(status, _)| status == 200)
    }

    /// Calls one of Caio's tools and returns its JSON answer; a tool error is an `Err`.
    pub fn call(&self, tool: &str, args: Value) -> Result<Value, AppError> {
        if !TOOLS.contains(&tool) {
            return Err(AppError::new("invalid", format!("Caio has no tool {tool}")));
        }
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": tool, "arguments": args },
        });
        let (status, text) = http("POST", "/mcp", Some(&self.token), &body.to_string())?;
        if status != 200 {
            return Err(AppError::new(
                "caio",
                format!("Caio answered {status}: {}", text.trim()),
            ));
        }
        let reply: Value = serde_json::from_str(&text).map_err(|e| AppError::new("caio", e))?;
        if let Some(e) = reply.get("error") {
            return Err(AppError::new(
                "caio",
                e["message"].as_str().unwrap_or("error").to_string(),
            ));
        }
        let result = &reply["result"];
        let content = result["content"][0]["text"].as_str().unwrap_or("");
        // Tool output is JSON text; input errors are plain text.
        let answer: Value =
            serde_json::from_str(content).unwrap_or_else(|_| json!({ "error": content }));
        if result["isError"].as_bool() == Some(true) {
            let message = answer["error"].as_str().unwrap_or(content).to_string();
            return Err(AppError::new("caio", message));
        }
        Ok(answer)
    }

    /// `docker compose up -d` in the checkout: brings back the database and the server.
    pub fn start(&self, docker: &Path) -> Result<(), AppError> {
        let out = Command::new(docker)
            .args(["compose", "up", "-d"])
            .current_dir(&self.dir)
            .stdin(Stdio::null())
            .output()?;
        if out.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(AppError::new(
                "caio",
                err.lines()
                    .last()
                    .unwrap_or("docker compose failed")
                    .to_string(),
            ))
        }
    }
}

/// One HTTP/1.0 request to the local server; 1.0 so the answer is never chunked.
fn http(
    method: &str,
    path: &str,
    token: Option<&str>,
    body: &str,
) -> Result<(u16, String), AppError> {
    let down = |e: std::io::Error| AppError::new("caio", format!("Caio is not running ({e})"));
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(down)?;
    // A reranked search on a CPU can take seconds.
    s.set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(down)?;
    let auth = token
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    write!(
        s,
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{PORT}\r\n{auth}\
         Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n\
         Content-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .map_err(down)?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(down)?;
    let raw = String::from_utf8_lossy(&raw);
    let (head, rest) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| AppError::new("caio", "Caio sent no HTTP status"))?;
    Ok((status, rest.to_string()))
}

/// Agent CLIs tine can connect to Caio, with the arguments that register it as an MCP
/// server for the user (`url`, `header`). Each agent keeps MCP servers in its own config.
pub const AGENTS: [(&str, &[&str]); 1] = [(
    "claude",
    &[
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "http",
        "caio",
        "{url}",
        "--header",
        "{header}",
    ],
)];

/// Where agent CLIs are installed. Apps started from Finder have only a minimal PATH.
pub fn find_tool(name: &str, home: &Path) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain([
            home.join(".local/bin"),
            "/opt/homebrew/bin".into(),
            "/usr/local/bin".into(),
        ])
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

/// Where to register Caio: a HOME, and the command that runs the agent CLI for it. The
/// private home of restricted tabs is written from inside the sandbox (`prefix` is a
/// `sandbox-exec` call), so a link planted there cannot redirect the write.
pub struct Target {
    pub home: PathBuf,
    pub prefix: Vec<std::ffi::OsString>,
}

/// Registers Caio with each installed agent, for each target. An earlier registration is
/// replaced, so a new token takes effect. Returns one line per agent and target.
pub fn connect(caio: &Caio, real_home: &Path, targets: &[Target]) -> Vec<String> {
    let header = format!("Authorization: Bearer {}", caio.token());
    let mut report = Vec::new();
    for (name, template) in AGENTS {
        let Some(bin) = find_tool(name, real_home) else {
            continue;
        };
        let args: Vec<String> = template
            .iter()
            .map(|a| a.replace("{url}", &caio.url()).replace("{header}", &header))
            .collect();
        for Target { home, prefix } in targets {
            let run = |args: &[&str]| {
                let mut c = match prefix.split_first() {
                    Some((program, rest)) => {
                        let mut c = Command::new(program);
                        c.args(rest).arg(&bin);
                        c
                    }
                    None => Command::new(&bin),
                };
                c.args(args).env("HOME", home).stdin(Stdio::null()).output()
            };
            let _ = run(&["mcp", "remove", "--scope", "user", "caio"]);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            let ok = run(&args).is_ok_and(|o| o.status.success());
            report.push(format!(
                "{name} ({}): {}",
                home.display(),
                if ok { "connected" } else { "failed" }
            ));
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_token_from_env() {
        let t = crate::fs::tests::TempDir::new();
        std::fs::write(t.path(".env"), "X=1\nCAIO_HTTP_TOKEN=\"abc123\"\n").unwrap();
        assert_eq!(Caio::load(&t.0).unwrap().token(), "abc123");
        std::fs::write(t.path(".env"), "CAIO_HTTP_TOKEN=\n").unwrap();
        assert_eq!(Caio::load(&t.0).err().map(|e| e.code), Some("caio"));
    }

    #[test]
    fn only_caio_tools_are_called() {
        let caio = Caio {
            dir: PathBuf::new(),
            token: "t".into(),
        };
        assert_eq!(caio.call("shell", json!({})).unwrap_err().code, "invalid");
    }

    /// Registers with the real claude CLI in scratch homes, one of them through the sandbox
    /// as for restricted tabs. Needs TINE_TEST_CAIO and claude; skipped otherwise.
    #[test]
    #[cfg(target_os = "macos")]
    fn connects_claude_in_scratch_homes() {
        use crate::fs::tests::TempDir;
        let (Some(dir), Some(real)) =
            (std::env::var_os("TINE_TEST_CAIO"), std::env::var_os("HOME"))
        else {
            eprintln!("skipping: TINE_TEST_CAIO is not set");
            return;
        };
        let real = PathBuf::from(real);
        let Some(claude) = find_tool("claude", &real) else {
            eprintln!("skipping: claude is not installed");
            return;
        };
        let caio = Caio::load(Path::new(&dir)).unwrap();
        let (plain, private, work) = (TempDir::new(), TempDir::new(), TempDir::new());
        let policy = crate::sandbox::Policy {
            writable: vec![private.0.clone(), std::env::temp_dir()],
            network: true,
            ..Default::default()
        };
        let mut prefix = vec![crate::sandbox::SANDBOX_EXEC.into()];
        prefix.extend(crate::sandbox::args(&work.0, &real, &policy).unwrap());
        let targets = [
            Target {
                home: plain.0.clone(),
                prefix: vec![],
            },
            Target {
                home: private.0.clone(),
                prefix,
            },
        ];
        let report = connect(&caio, &real, &targets);
        assert!(
            report.iter().all(|l| l.ends_with("connected")),
            "{report:?}"
        );
        for home in [&plain.0, &private.0] {
            let list = Command::new(&claude)
                .args(["mcp", "get", "caio"])
                .env("HOME", home)
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&list.stdout);
            assert!(text.contains("127.0.0.1:3920/mcp"), "{text}");
        }
    }

    /// Needs the local Caio from the README's quick start; skipped when it is not running.
    #[test]
    fn answers_from_a_running_caio() {
        let Some(dir) = std::env::var_os("TINE_TEST_CAIO") else {
            eprintln!("skipping: TINE_TEST_CAIO (a CompactAIO checkout) is not set");
            return;
        };
        let caio = Caio::load(Path::new(&dir)).unwrap();
        assert!(caio.up());
        let err = caio.call(
            "check_symbol",
            json!({ "package": "tine-no-such-package", "symbol": "x" }),
        );
        assert!(err.unwrap_err().message.contains("not indexed"));
        let bad = Caio {
            dir: PathBuf::new(),
            token: "wrong".into(),
        };
        assert!(
            bad.call("search_docs", json!({ "query": "x" }))
                .unwrap_err()
                .message
                .contains("401")
        );
    }
}
