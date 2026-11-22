use crate::error::AppError;
use crate::fs::READ_CAP;
use git2::{Delta, Diff, DiffFindOptions, DiffOptions, Oid, Patch, Repository, Tree};
use serde::Serialize;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    /// The previous path of a staged rename.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: &'static str,
    pub staged: bool,
    pub added: usize,
    pub removed: usize,
}

#[derive(Serialize, Debug)]
pub struct Status {
    pub branch: String,
    pub files: Vec<FileChange>,
}

#[derive(Serialize, Debug)]
pub struct FileDiff {
    pub old_text: String,
    pub new_text: String,
    /// Binary or larger than 2 MB on either side; both texts are then empty.
    pub binary: bool,
}

/// `repo` is the repository's working-tree root as the frontend names it; returned paths
/// are built on it, so they match the file tree's paths even through symlinks.
fn open(repo: &Path) -> Result<Repository, AppError> {
    Repository::open(repo).map_err(|e| AppError::new("not_repo", e.message()))
}

fn relative<'a>(repo: &Path, path: &'a Path) -> Result<&'a Path, AppError> {
    path.strip_prefix(repo).map_err(|_| {
        AppError::new(
            "invalid",
            format!("{} is outside {}", path.display(), repo.display()),
        )
    })
}

fn absolute(repo: &Path, rel: &Path) -> String {
    repo.join(rel).to_string_lossy().into_owned()
}

fn branch(repo: &Repository) -> String {
    match repo.head() {
        Ok(head) if repo.head_detached().unwrap_or(false) => head
            .target()
            .map_or("HEAD".into(), |id| id.to_string()[..7].to_string()),
        Ok(head) => head.shorthand().unwrap_or("HEAD").to_string(),
        // No commits yet: HEAD still names the branch it will create.
        Err(_) => repo
            .find_reference("HEAD")
            .ok()
            .and_then(|r| {
                r.symbolic_target()
                    .ok()
                    .flatten()
                    .map(|t| t.trim_start_matches("refs/heads/").to_string())
            })
            .unwrap_or_else(|| "HEAD".into()),
    }
}

fn head_tree(repo: &Repository) -> Option<Tree<'_>> {
    repo.head().ok()?.peel_to_tree().ok()
}

fn staged_diff(repo: &Repository) -> Result<Diff<'_>, AppError> {
    let mut diff = repo.diff_tree_to_index(head_tree(repo).as_ref(), None, None)?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;
    Ok(diff)
}

fn unstaged_diff(repo: &Repository) -> Result<Diff<'_>, AppError> {
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    Ok(repo.diff_index_to_workdir(None, Some(&mut opts))?)
}

fn changes(diff: &Diff, repo: &Path, staged: bool) -> Result<Vec<FileChange>, AppError> {
    let mut out = Vec::new();
    for (i, delta) in diff.deltas().enumerate() {
        let status = match delta.status() {
            Delta::Added | Delta::Copied => "added",
            Delta::Deleted => "deleted",
            Delta::Modified => "modified",
            Delta::Renamed => "renamed",
            Delta::Untracked => "untracked",
            Delta::Typechange => "typechange",
            Delta::Conflicted => "conflicted",
            _ => continue,
        };
        let Some(path) = delta.new_file().path().or(delta.old_file().path()) else {
            continue;
        };
        let old_path = match delta.status() {
            Delta::Renamed => delta.old_file().path().map(|p| absolute(repo, p)),
            _ => None,
        };
        let (added, removed) = match Patch::from_diff(diff, i)? {
            Some(patch) => {
                let (_, added, removed) = patch.line_stats()?;
                (added, removed)
            }
            None => (0, 0),
        };
        out.push(FileChange {
            path: absolute(repo, path),
            old_path,
            status,
            staged,
            added,
            removed,
        });
    }
    Ok(out)
}

/// Branch name plus every changed file: staged changes (HEAD to index) first, then
/// unstaged ones (index to working tree, including untracked files).
pub fn status(repo: &Path) -> Result<Status, AppError> {
    let r = open(repo)?;
    let mut files = changes(&staged_diff(&r)?, repo, true)?;
    files.extend(changes(&unstaged_diff(&r)?, repo, false)?);
    Ok(Status {
        branch: branch(&r),
        files,
    })
}

/// Both full texts of one file's change; CodeMirror computes the visual diff.
/// Staged: HEAD (at the old path, for renames) against the index. Unstaged: the index
/// (empty for untracked files) against the file on disk (empty if deleted).
pub fn diff_file(repo: &Path, path: &Path, staged: bool) -> Result<FileDiff, AppError> {
    let r = open(repo)?;
    let rel = relative(repo, path)?;
    let blob = |id: Oid| -> Result<Vec<u8>, AppError> { Ok(r.find_blob(id)?.content().to_vec()) };
    let index = r.index()?;
    let in_index = || index.get_path(rel, 0).map(|e| blob(e.id)).transpose();

    let (old, new) = if staged {
        let diff = staged_diff(&r)?;
        let old_rel = diff
            .deltas()
            .find(|d| d.new_file().path() == Some(rel))
            .and_then(|d| d.old_file().path().map(Path::to_path_buf))
            .unwrap_or_else(|| rel.to_path_buf());
        let old = match head_tree(&r).and_then(|t| t.get_path(&old_rel).ok()) {
            Some(entry) => Some(blob(entry.id())?),
            None => None,
        };
        (old, in_index()?)
    } else {
        let new = match std::fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        (in_index()?, new)
    };

    let (old, new) = (old.unwrap_or_default(), new.unwrap_or_default());
    let text = |b: Vec<u8>| -> Option<String> {
        if b.len() as u64 > READ_CAP || b[..b.len().min(8192)].contains(&0) {
            return None;
        }
        String::from_utf8(b).ok()
    };
    Ok(match (text(old), text(new)) {
        (Some(old_text), Some(new_text)) => FileDiff {
            old_text,
            new_text,
            binary: false,
        },
        _ => FileDiff {
            old_text: String::new(),
            new_text: String::new(),
            binary: true,
        },
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::fs::tests::TempDir;
    use std::fs;

    /// A repository on branch `main` with an identity, so commits work without global config.
    pub fn repo() -> (TempDir, Repository) {
        let t = TempDir::new();
        let r = Repository::init_opts(
            &t.0,
            git2::RepositoryInitOptions::new().initial_head("main"),
        )
        .unwrap();
        let mut cfg = r.config().unwrap();
        cfg.set_str("user.name", "Test User").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        (t, r)
    }

    /// `git add` (or `git rm --cached` for files gone from disk), done with git2 directly.
    fn stage(t: &TempDir, paths: &[&str]) {
        let r = Repository::open(&t.0).unwrap();
        let mut index = r.index().unwrap();
        for p in paths {
            if t.path(p).exists() {
                index.add_path(Path::new(p)).unwrap();
            } else {
                index.remove_path(Path::new(p)).unwrap();
            }
        }
        index.write().unwrap();
    }

    fn commit_all(t: &TempDir, paths: &[&str], msg: &str) {
        stage(t, paths);
        let r = Repository::open(&t.0).unwrap();
        let sig = r.signature().unwrap();
        let tree = r
            .find_tree(r.index().unwrap().write_tree().unwrap())
            .unwrap();
        let parent = r.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<_> = parent.iter().collect();
        r.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap();
    }

    fn s(p: PathBuf) -> String {
        p.to_string_lossy().into_owned()
    }

    fn find<'a>(st: &'a Status, path: &Path, staged: bool) -> &'a FileChange {
        st.files
            .iter()
            .find(|f| f.path == path.to_string_lossy() && f.staged == staged)
            .unwrap_or_else(|| panic!("{} (staged={staged}) not in {:?}", path.display(), st.files))
    }

    #[test]
    fn modified_file_counts_lines_and_diffs() {
        let (t, _r) = repo();
        fs::write(t.path("a.txt"), "1\n2\n3\n").unwrap();
        commit_all(&t, &["a.txt"], "init");
        fs::write(t.path("a.txt"), "1\nX\n3\n4\n").unwrap();

        let st = status(&t.0).unwrap();
        assert_eq!(st.branch, "main");
        assert_eq!(st.files.len(), 1);
        let f = find(&st, &t.path("a.txt"), false);
        assert_eq!((f.status, f.added, f.removed), ("modified", 2, 1));

        let d = diff_file(&t.0, &t.path("a.txt"), false).unwrap();
        assert_eq!(
            (d.old_text.as_str(), d.new_text.as_str(), d.binary),
            ("1\n2\n3\n", "1\nX\n3\n4\n", false)
        );
    }

    #[test]
    fn added_untracked_and_deleted() {
        let (t, _r) = repo();
        fs::write(t.path("gone.txt"), "bye\n").unwrap();
        commit_all(&t, &["gone.txt"], "init");
        fs::remove_file(t.path("gone.txt")).unwrap();
        fs::create_dir(t.path("dir")).unwrap();
        fs::write(t.path("dir/new.txt"), "a\nb\n").unwrap();
        fs::write(t.path("staged.txt"), "s\n").unwrap();
        stage(&t, &["staged.txt"]);

        let st = status(&t.0).unwrap();
        let staged = find(&st, &t.path("staged.txt"), true);
        assert_eq!(
            (staged.status, staged.added, staged.removed),
            ("added", 1, 0)
        );
        let untracked = find(&st, &t.path("dir/new.txt"), false);
        assert_eq!((untracked.status, untracked.added), ("untracked", 2));
        let gone = find(&st, &t.path("gone.txt"), false);
        assert_eq!((gone.status, gone.removed), ("deleted", 1));

        assert_eq!(
            diff_file(&t.0, &t.path("staged.txt"), true)
                .unwrap()
                .new_text,
            "s\n"
        );
        assert_eq!(
            diff_file(&t.0, &t.path("staged.txt"), true)
                .unwrap()
                .old_text,
            ""
        );
        assert_eq!(
            diff_file(&t.0, &t.path("dir/new.txt"), false)
                .unwrap()
                .new_text,
            "a\nb\n"
        );
        let d = diff_file(&t.0, &t.path("gone.txt"), false).unwrap();
        assert_eq!((d.old_text.as_str(), d.new_text.as_str()), ("bye\n", ""));
    }

    #[test]
    fn staged_rename_reports_both_paths() {
        let (t, _r) = repo();
        fs::write(t.path("old.txt"), "same\ncontent\nhere\n").unwrap();
        commit_all(&t, &["old.txt"], "init");
        fs::rename(t.path("old.txt"), t.path("new.txt")).unwrap();
        stage(&t, &["old.txt", "new.txt"]);

        let st = status(&t.0).unwrap();
        assert_eq!(st.files.len(), 1, "{:?}", st.files);
        let f = find(&st, &t.path("new.txt"), true);
        assert_eq!(f.status, "renamed");
        assert_eq!(f.old_path.as_deref(), Some(s(t.path("old.txt")).as_str()));
        let d = diff_file(&t.0, &t.path("new.txt"), true).unwrap();
        assert_eq!(d.old_text, d.new_text);
    }

    #[test]
    fn unborn_repo_lists_staged_and_untracked() {
        let (t, _r) = repo();
        fs::write(t.path("a.txt"), "a\n").unwrap();
        fs::write(t.path("b.txt"), "b\n").unwrap();
        stage(&t, &["a.txt"]);
        let st = status(&t.0).unwrap();
        assert_eq!(st.branch, "main");
        assert_eq!(find(&st, &t.path("a.txt"), true).status, "added");
        assert_eq!(find(&st, &t.path("b.txt"), false).status, "untracked");
    }

    #[test]
    fn diff_rejects_paths_outside_the_repo() {
        let (t, _r) = repo();
        assert_eq!(
            diff_file(&t.0, Path::new("/etc/hosts"), false)
                .unwrap_err()
                .code,
            "invalid"
        );
    }

    #[test]
    fn binary_files_are_flagged() {
        let (t, _r) = repo();
        fs::write(t.path("img.bin"), [0u8, 1, 2, 3]).unwrap();
        assert!(diff_file(&t.0, &t.path("img.bin"), false).unwrap().binary);
    }

    #[test]
    fn outside_a_repo_is_not_repo() {
        let t = TempDir::new();
        assert_eq!(status(&t.0).unwrap_err().code, "not_repo");
    }
}
