use crate::error::AppError;
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// `fs_read_file` never returns more than this; larger files come back truncated.
pub const READ_CAP: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Dir,
    Other,
}

fn kind_of(m: &fs::Metadata) -> Kind {
    if m.is_dir() {
        Kind::Dir
    } else if m.is_file() {
        Kind::File
    } else {
        Kind::Other
    }
}

/// Milliseconds since the epoch: exact in a JS number, so the frontend can echo it back.
fn mtime_ms(m: &fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

#[derive(Serialize, Debug)]
pub struct Entry {
    pub name: String,
    pub kind: Kind,
    pub ignored: bool,
}

/// Directory entries, folders first, then case-insensitive by name.
pub fn list_dir(path: &Path) -> Result<Vec<Entry>, AppError> {
    let dir = fs::canonicalize(path)?;
    let repo = git2::Repository::discover(&dir).ok();
    let workdir = repo
        .as_ref()
        .and_then(|r| r.workdir())
        .and_then(|w| fs::canonicalize(w).ok());

    let mut entries = Vec::new();
    for e in fs::read_dir(&dir)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        // Follow symlinks for the kind; a broken link is `Other`.
        let kind = fs::metadata(e.path()).map_or(Kind::Other, |m| kind_of(&m));
        let ignored = name == ".git"
            || match (&repo, &workdir) {
                (Some(repo), Some(workdir)) => {
                    dir.join(&name).strip_prefix(workdir).is_ok_and(|rel| {
                        // A trailing slash makes directory-only patterns such as `target/` match.
                        let rel = rel.to_string_lossy();
                        let rel = if kind == Kind::Dir {
                            format!("{rel}/")
                        } else {
                            rel.into_owned()
                        };
                        repo.is_path_ignored(rel).unwrap_or(false)
                    })
                }
                _ => false,
            };
        entries.push(Entry {
            name,
            kind,
            ignored,
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != Kind::Dir)
            .cmp(&(b.kind != Kind::Dir))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Files under `root` for the command palette: no `.git`, nothing git ignores, symlinks not
/// followed (no loops). Stops at `limit` files, or after visiting 20x that many entries, so a
/// huge folder outside any repo (a home folder) cannot stall it. Paths are built on `root`.
pub fn find_files(root: &Path, limit: usize) -> Result<Vec<String>, AppError> {
    let base = fs::canonicalize(root)?;
    let repo = git2::Repository::discover(&base).ok();
    let workdir = repo
        .as_ref()
        .and_then(|r| r.workdir())
        .and_then(|w| fs::canonicalize(w).ok());
    let ignored = |path: &Path, dir: bool| match (&repo, &workdir) {
        (Some(repo), Some(workdir)) => path.strip_prefix(workdir).is_ok_and(|rel| {
            let rel = rel.to_string_lossy();
            let rel = if dir {
                format!("{rel}/")
            } else {
                rel.into_owned()
            };
            repo.is_path_ignored(rel).unwrap_or(false)
        }),
        _ => false,
    };

    let mut files = Vec::new();
    let mut stack = vec![base.clone()];
    let mut visited = 0;
    'walk: while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > limit * 20 {
                break 'walk;
            }
            if entry.file_name() == ".git" {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                if !ignored(&path, true) {
                    stack.push(path);
                }
            } else if kind.is_file() && !ignored(&path, false) {
                let rel = path.strip_prefix(&base).expect("walk stays under base");
                files.push(root.join(rel).to_string_lossy().into_owned());
                if files.len() >= limit {
                    break 'walk;
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

#[derive(Serialize, Debug)]
pub struct FileText {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
    pub mtime: u64,
}

/// One line that contains the search text. `line` and `col` count from 1; `col` in characters.
#[derive(Serialize, Debug, PartialEq)]
pub struct Match {
    pub path: String,
    pub line: usize,
    pub col: usize,
    pub text: String,
}

/// Lines containing `query` (ignoring case) in the files `find_files` lists under `root`.
/// Skips binary files and files over the read cap; stops at `limit` matches.
pub fn search(root: &Path, query: &str, limit: usize) -> Result<Vec<Match>, AppError> {
    let needle = query.to_lowercase();
    if needle.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for path in find_files(root, 50_000)? {
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.len() > READ_CAP {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        if bytes[..bytes.len().min(8192)].contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            let lower = line.to_lowercase();
            let Some(at) = lower.find(&needle) else {
                continue;
            };
            let trimmed = line.trim_start();
            out.push(Match {
                path: path.clone(),
                line: i + 1,
                // Lowercasing can change byte lengths, so count characters in the lowered line.
                col: lower[..at].chars().count() + 1,
                text: trimmed.chars().take(200).collect(),
            });
            if out.len() >= limit {
                return Ok(out);
            }
        }
    }
    Ok(out)
}

/// Image previews: these formats only, up to 20 MB, as raw bytes for the viewer.
const IMAGE_EXT: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const IMAGE_CAP: u64 = 20 * 1024 * 1024;

/// An image's bytes. Only image files, so this cannot become a way to read anything else as
/// raw bytes; the viewer shows them through a blob: URL instead of a file-serving protocol.
pub fn read_image(path: &Path) -> Result<Vec<u8>, AppError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !IMAGE_EXT.contains(&ext.as_str()) {
        return Err(AppError::new(
            "invalid",
            format!("{} is not an image", path.display()),
        ));
    }
    let file = fs::File::open(path)?;
    if file.metadata()?.len() > IMAGE_CAP {
        return Err(AppError::new("too_large", "Image larger than 20 MB"));
    }
    let mut buf = Vec::new();
    file.take(IMAGE_CAP).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Reads at most 2 MB. Files with a NUL byte or invalid UTF-8 are `binary` with empty text,
/// so they are never shown (or saved back) garbled.
pub fn read_file(path: &Path) -> Result<FileText, AppError> {
    let file = fs::File::open(path)?;
    let meta = file.metadata()?;
    if meta.is_dir() {
        return Err(AppError::new(
            "is_dir",
            format!("{} is a folder", path.display()),
        ));
    }
    let mut buf = Vec::new();
    file.take(READ_CAP).read_to_end(&mut buf)?;
    let truncated = meta.len() > READ_CAP;
    let valid = match std::str::from_utf8(&buf) {
        Ok(_) => Some(buf.len()),
        // Only a sequence cut off by the size cap is acceptable.
        Err(e) if truncated && e.error_len().is_none() => Some(e.valid_up_to()),
        Err(_) => None,
    };
    let binary = valid.is_none() || buf[..buf.len().min(8192)].contains(&0);
    let text = match valid {
        Some(len) if !binary => {
            buf.truncate(len);
            String::from_utf8(buf).expect("validated above")
        }
        _ => String::new(),
    };
    Ok(FileText {
        text,
        truncated,
        binary,
        mtime: mtime_ms(&meta),
    })
}

#[derive(Serialize, Debug)]
pub struct Stat {
    pub kind: Kind,
    pub size: u64,
    pub mtime: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_count: Option<usize>,
}

pub fn stat(path: &Path) -> Result<Stat, AppError> {
    let meta = fs::metadata(path)?;
    let kind = kind_of(&meta);
    let item_count = match kind {
        Kind::Dir => Some(fs::read_dir(path)?.count()),
        _ => None,
    };
    Ok(Stat {
        kind,
        size: meta.len(),
        mtime: mtime_ms(&meta),
        item_count,
    })
}

/// Atomic write (temporary file, then rename). With `expected_mtime`, fails with `conflict`
/// if the file changed or vanished since it was read, so an agent's edit is never overwritten.
pub fn write_file(path: &Path, text: &str, expected_mtime: Option<u64>) -> Result<u64, AppError> {
    let existing = fs::metadata(path).ok();
    if let Some(expected) = expected_mtime
        && existing.as_ref().map(mtime_ms) != Some(expected)
    {
        return Err(AppError::new(
            "conflict",
            format!("{} changed on disk", path.display()),
        ));
    }
    // Write through a symlink to its target rather than replacing the link with a file.
    let target = if existing.is_some() {
        fs::canonicalize(path)?
    } else {
        path.to_path_buf()
    };
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(AppError::new(
            "invalid",
            format!("{} is not a file path", path.display()),
        ));
    };
    let tmp = dir.join(format!(
        ".{}.tine-{}.tmp",
        name.to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        if let Some(meta) = &existing {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    Ok(mtime_ms(&fs::metadata(&target)?))
}

pub fn create_file(path: &Path) -> Result<(), AppError> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    Ok(())
}

pub fn create_dir(path: &Path) -> Result<(), AppError> {
    Ok(fs::create_dir(path)?)
}

/// Fails with `exists` rather than replacing `to`. A case-only rename (`a` to `A`) on a
/// case-insensitive disk sees `to` as the same file and is allowed.
pub fn rename(from: &Path, to: &Path) -> Result<(), AppError> {
    let src = fs::symlink_metadata(from)?;
    if let Ok(dst) = fs::symlink_metadata(to)
        && (dst.dev(), dst.ino()) != (src.dev(), src.ino())
    {
        return Err(AppError::new(
            "exists",
            format!("{} already exists", to.display()),
        ));
    }
    Ok(fs::rename(from, to)?)
}

/// Moves to the system trash; tine never deletes permanently.
pub fn trash(paths: &[String]) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        // NSFileManager needs no "control Finder" permission prompt, unlike the Finder method.
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete_all(paths).map_err(AppError::io)
    }
    #[cfg(not(target_os = "macos"))]
    trash::delete_all(paths).map_err(AppError::io)
}

/// Shows the item in Finder, or opens its folder in the Linux file manager.
pub fn reveal(path: &Path) -> Result<(), AppError> {
    fs::symlink_metadata(path)?;
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(path);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path.parent().unwrap_or(path));
        c
    };
    cmd.spawn()?;
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A temporary directory removed on drop; tests avoid a tempfile dependency with this.
    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "tine-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(fs::canonicalize(dir).unwrap())
        }

        pub fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn search_finds_lines_ignoring_case_and_skips_binary() {
        let t = TempDir::new();
        std::fs::write(t.path("a.rs"), "fn main() {\n    let Total = 1;\n}\n").unwrap();
        std::fs::write(t.path("b.bin"), b"total\0").unwrap();
        let found = search(&t.0, "total", 10).unwrap();
        assert_eq!(
            found,
            vec![Match {
                path: t.path("a.rs").to_string_lossy().into_owned(),
                line: 2,
                col: 9,
                text: "let Total = 1;".into(),
            }]
        );
        assert!(search(&t.0, "  ", 10).unwrap().is_empty());
        std::fs::write(t.path("c.txt"), "total\ntotal\ntotal\n").unwrap();
        assert_eq!(search(&t.0, "total", 2).unwrap().len(), 2);
    }

    #[test]
    fn read_image_only_reads_images() {
        let t = TempDir::new();
        let png = t.path("a.PNG");
        std::fs::write(&png, b"\x89PNG fake").unwrap();
        assert_eq!(read_image(&png).unwrap(), b"\x89PNG fake");
        let secret = t.path("id_rsa");
        std::fs::write(&secret, b"key").unwrap();
        assert_eq!(read_image(&secret).unwrap_err().code, "invalid");
    }

    #[test]
    fn list_dir_sorts_folders_first_and_marks_ignored() {
        let t = TempDir::new();
        git2::Repository::init(&t.0).unwrap();
        fs::write(t.path(".gitignore"), "target/\n*.log\n").unwrap();
        fs::create_dir(t.path("target")).unwrap();
        fs::create_dir(t.path("Src")).unwrap();
        fs::write(t.path("b.txt"), "").unwrap();
        fs::write(t.path("A.md"), "").unwrap();
        fs::write(t.path("debug.log"), "").unwrap();

        let entries = list_dir(&t.0).unwrap();
        let names: Vec<_> = entries
            .iter()
            .map(|e| (e.name.as_str(), e.kind, e.ignored))
            .collect();
        assert_eq!(
            names,
            [
                (".git", Kind::Dir, true),
                ("Src", Kind::Dir, false),
                ("target", Kind::Dir, true),
                (".gitignore", Kind::File, false),
                ("A.md", Kind::File, false),
                ("b.txt", Kind::File, false),
                ("debug.log", Kind::File, true),
            ]
        );
    }

    #[test]
    fn list_dir_outside_a_repo_ignores_nothing() {
        let t = TempDir::new();
        fs::write(t.path("x.log"), "").unwrap();
        assert!(!list_dir(&t.0).unwrap()[0].ignored);
    }

    #[test]
    fn read_file_text_binary_and_truncated() {
        let t = TempDir::new();
        fs::write(t.path("a.txt"), "héllo").unwrap();
        let r = read_file(&t.path("a.txt")).unwrap();
        assert_eq!(
            (r.text.as_str(), r.truncated, r.binary),
            ("héllo", false, false)
        );
        assert!(r.mtime > 0);

        fs::write(t.path("bin"), [0x89, b'P', 0, 1, 2]).unwrap();
        let r = read_file(&t.path("bin")).unwrap();
        assert!(r.binary && r.text.is_empty());

        fs::write(t.path("latin1.txt"), [b'c', 0xe9]).unwrap();
        assert!(read_file(&t.path("latin1.txt")).unwrap().binary);

        // A 2-byte character straddling the cap must be dropped, not reported as binary.
        let mut big = vec![b'a'; READ_CAP as usize - 1];
        big.extend("é".as_bytes());
        big.extend(b"tail");
        fs::write(t.path("big.txt"), &big).unwrap();
        let r = read_file(&t.path("big.txt")).unwrap();
        assert!(r.truncated && !r.binary);
        assert_eq!(r.text.len(), READ_CAP as usize - 1);

        assert_eq!(read_file(&t.0).unwrap_err().code, "is_dir");
        assert_eq!(read_file(&t.path("missing")).unwrap_err().code, "not_found");
    }

    #[test]
    fn stat_reports_kind_size_and_item_count() {
        let t = TempDir::new();
        fs::write(t.path("f"), "1234").unwrap();
        fs::create_dir(t.path("d")).unwrap();
        fs::write(t.path("d/x"), "").unwrap();
        let f = stat(&t.path("f")).unwrap();
        assert_eq!((f.kind, f.size, f.item_count), (Kind::File, 4, None));
        let d = stat(&t.path("d")).unwrap();
        assert_eq!((d.kind, d.item_count), (Kind::Dir, Some(1)));
        assert_eq!(stat(&t.path("nope")).unwrap_err().code, "not_found");
    }

    #[test]
    fn write_file_is_atomic_and_detects_conflicts() {
        let t = TempDir::new();
        let p = t.path("a.txt");
        let m1 = write_file(&p, "one", None).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "one");

        let m2 = write_file(&p, "two", Some(m1)).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "two");

        // Someone else (an agent) changes the file; saving with the old mtime must fail.
        std::thread::sleep(std::time::Duration::from_millis(10));
        fs::write(&p, "agent").unwrap();
        let err = write_file(&p, "mine", Some(m2)).unwrap_err();
        assert_eq!(err.code, "conflict");
        assert_eq!(fs::read_to_string(&p).unwrap(), "agent");

        // A file deleted since it was read is a conflict too, not a silent re-create.
        fs::remove_file(&p).unwrap();
        assert_eq!(
            write_file(&p, "mine", Some(m2)).unwrap_err().code,
            "conflict"
        );

        // No temporary files left behind.
        assert_eq!(fs::read_dir(&t.0).unwrap().count(), 0);
    }

    #[test]
    fn write_file_keeps_permissions_and_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let t = TempDir::new();
        let real = t.path("real.sh");
        fs::write(&real, "#!/bin/sh").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&real, t.path("link.sh")).unwrap();

        write_file(&t.path("link.sh"), "#!/bin/sh\necho hi", None).unwrap();
        assert!(
            fs::symlink_metadata(t.path("link.sh"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read_to_string(&real).unwrap(), "#!/bin/sh\necho hi");
        assert_eq!(
            fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    fn create_fails_when_exists() {
        let t = TempDir::new();
        create_file(&t.path("f")).unwrap();
        fs::write(t.path("f"), "keep").unwrap();
        assert_eq!(create_file(&t.path("f")).unwrap_err().code, "exists");
        assert_eq!(fs::read_to_string(t.path("f")).unwrap(), "keep");

        create_dir(&t.path("d")).unwrap();
        assert_eq!(create_dir(&t.path("d")).unwrap_err().code, "exists");
        assert_eq!(create_dir(&t.path("f")).unwrap_err().code, "exists");
    }

    #[test]
    fn rename_refuses_to_overwrite() {
        let t = TempDir::new();
        fs::write(t.path("a"), "a").unwrap();
        fs::write(t.path("b"), "b").unwrap();
        assert_eq!(
            rename(&t.path("a"), &t.path("b")).unwrap_err().code,
            "exists"
        );
        assert_eq!(fs::read_to_string(t.path("b")).unwrap(), "b");

        rename(&t.path("a"), &t.path("c")).unwrap();
        assert!(!t.path("a").exists());
        assert_eq!(fs::read_to_string(t.path("c")).unwrap(), "a");

        // Case-only rename works on case-insensitive (macOS) and case-sensitive disks.
        rename(&t.path("c"), &t.path("C")).unwrap();
        let names: Vec<_> = fs::read_dir(&t.0)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert!(names.iter().any(|n| n == "C"));

        fs::create_dir(t.path("dir")).unwrap();
        rename(&t.path("dir"), &t.path("dir2")).unwrap();
        assert!(t.path("dir2").is_dir());
        assert_eq!(
            rename(&t.path("missing"), &t.path("x")).unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn find_files_skips_git_and_ignored_files() {
        let t = TempDir::new();
        git2::Repository::init(&t.0).unwrap();
        fs::write(t.path(".gitignore"), "node_modules/\n*.log\n").unwrap();
        fs::create_dir_all(t.path("src/deep")).unwrap();
        fs::create_dir_all(t.path("node_modules/pkg")).unwrap();
        fs::write(t.path("src/deep/a.rs"), "").unwrap();
        fs::write(t.path("src/b.ts"), "").unwrap();
        fs::write(t.path("node_modules/pkg/index.js"), "").unwrap();
        fs::write(t.path("debug.log"), "").unwrap();

        let root = t.0.to_string_lossy().into_owned();
        let found = find_files(&t.0, 100).unwrap();
        let rel: Vec<_> = found
            .iter()
            .map(|p| p.strip_prefix(&root).unwrap())
            .collect();
        assert_eq!(rel, ["/.gitignore", "/src/b.ts", "/src/deep/a.rs"]);
        assert_eq!(find_files(&t.0, 2).unwrap().len(), 2);
    }

    #[test]
    fn reveal_rejects_missing_paths() {
        let t = TempDir::new();
        assert_eq!(reveal(&t.path("missing")).unwrap_err().code, "not_found");
    }

    /// Puts one small file into the real system trash, so it only runs on request:
    /// `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn trash_moves_file_out_of_place() {
        let t = TempDir::new();
        let p = t.path("tine-trash-test.txt");
        fs::write(&p, "trash me").unwrap();
        trash(&[p.to_string_lossy().into_owned()]).unwrap();
        assert!(!p.exists());
    }
}
