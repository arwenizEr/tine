use crate::error::AppError;
use crate::fs::READ_CAP;
use git2::{Delta, Diff, DiffFindOptions, DiffOptions, Oid, Patch, Repository, Tree};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    /// The previous path of a staged rename; unstaging needs both paths.
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

fn relatives(repo: &Path, paths: &[String]) -> Result<Vec<PathBuf>, AppError> {
    paths
        .iter()
        .map(|p| relative(repo, Path::new(p)).map(Path::to_path_buf))
        .collect()
}

/// Stages files as they are on disk; a file missing from disk stages its deletion.
pub fn stage(repo: &Path, paths: &[String]) -> Result<(), AppError> {
    let r = open(repo)?;
    let mut index = r.index()?;
    for (abs, rel) in paths.iter().zip(relatives(repo, paths)?) {
        if Path::new(abs).symlink_metadata().is_ok() {
            index.add_path(&rel)?;
        } else {
            index.remove_path(&rel)?;
        }
    }
    Ok(index.write()?)
}

/// Resets the index entries to HEAD, leaving the working tree alone (`git restore --staged`).
pub fn unstage(repo: &Path, paths: &[String]) -> Result<(), AppError> {
    let r = open(repo)?;
    let rels = relatives(repo, paths)?;
    match r
        .head()
        .ok()
        .and_then(|h| h.peel(git2::ObjectType::Commit).ok())
    {
        Some(head) => r.reset_default(Some(&head), rels.iter().map(PathBuf::as_path))?,
        None => {
            // No commits yet: unstaging means dropping the entry from the index.
            let mut index = r.index()?;
            for rel in &rels {
                index.remove_path(rel)?;
            }
            index.write()?;
        }
    }
    Ok(())
}

/// Commits the index with the user's configured name and email. libgit2 runs no hooks.
pub fn commit(repo: &Path, message: &str) -> Result<String, AppError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::new(
            "empty_message",
            "Write a commit message first.",
        ));
    }
    let r = open(repo)?;
    let sig = r.signature().map_err(|_| {
        AppError::new(
            "no_identity",
            "Set your name and email first: git config --global user.name / user.email",
        )
    })?;
    let tree_id = r.index()?.write_tree()?;
    let tree = r.find_tree(tree_id)?;
    let parent = r.head().ok().and_then(|h| h.peel_to_commit().ok());
    let unchanged = match &parent {
        Some(p) => p.tree_id() == tree_id,
        None => tree.is_empty(),
    };
    if unchanged {
        return Err(AppError::new("nothing_to_commit", "Nothing is staged."));
    }
    let parents: Vec<_> = parent.iter().collect();
    let id = r.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &format!("{message}\n"),
        &tree,
        &parents,
    )?;
    Ok(id.to_string())
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

    fn s(p: PathBuf) -> String {
        p.to_string_lossy().into_owned()
    }

    fn commit_all(t: &TempDir, paths: &[&str], msg: &str) {
        stage(
            &t.0,
            &paths.iter().map(|p| s(t.path(p))).collect::<Vec<_>>(),
        )
        .unwrap();
        commit(&t.0, msg).unwrap();
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
        stage(&t.0, &[s(t.path("staged.txt"))]).unwrap();

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
    fn staged_rename_reports_both_paths_and_unstages() {
        let (t, _r) = repo();
        fs::write(t.path("old.txt"), "same\ncontent\nhere\n").unwrap();
        commit_all(&t, &["old.txt"], "init");
        fs::rename(t.path("old.txt"), t.path("new.txt")).unwrap();
        stage(&t.0, &[s(t.path("old.txt")), s(t.path("new.txt"))]).unwrap();

        let st = status(&t.0).unwrap();
        assert_eq!(st.files.len(), 1, "{:?}", st.files);
        let f = find(&st, &t.path("new.txt"), true);
        assert_eq!(f.status, "renamed");
        assert_eq!(f.old_path.as_deref(), Some(s(t.path("old.txt")).as_str()));
        let d = diff_file(&t.0, &t.path("new.txt"), true).unwrap();
        assert_eq!(d.old_text, d.new_text);

        unstage(&t.0, &[s(t.path("old.txt")), s(t.path("new.txt"))]).unwrap();
        let st = status(&t.0).unwrap();
        assert!(st.files.iter().all(|f| !f.staged), "{:?}", st.files);
        assert_eq!(find(&st, &t.path("old.txt"), false).status, "deleted");
        assert_eq!(find(&st, &t.path("new.txt"), false).status, "untracked");
    }

    #[test]
    fn binary_files_are_flagged() {
        let (t, _r) = repo();
        fs::write(t.path("img.bin"), [0u8, 1, 2, 3]).unwrap();
        assert!(diff_file(&t.0, &t.path("img.bin"), false).unwrap().binary);
    }

    #[test]
    fn stage_and_unstage_round_trip_before_first_commit() {
        let (t, _r) = repo();
        fs::write(t.path("a.txt"), "a\n").unwrap();
        stage(&t.0, &[s(t.path("a.txt"))]).unwrap();
        assert!(find(&status(&t.0).unwrap(), &t.path("a.txt"), true).staged);
        unstage(&t.0, &[s(t.path("a.txt"))]).unwrap();
        assert_eq!(
            find(&status(&t.0).unwrap(), &t.path("a.txt"), false).status,
            "untracked"
        );
    }

    #[test]
    fn commit_uses_configured_identity() {
        let (t, r) = repo();
        fs::write(t.path("a.txt"), "a\n").unwrap();
        stage(&t.0, &[s(t.path("a.txt"))]).unwrap();
        let id = commit(&t.0, "  first commit \n").unwrap();

        let c = r.find_commit(Oid::from_str(&id).unwrap()).unwrap();
        assert_eq!(c.message().ok(), Some("first commit\n"));
        assert_eq!(c.author().name().ok(), Some("Test User"));
        assert_eq!(c.author().email().ok(), Some("test@example.com"));
        assert_eq!(r.head().unwrap().target(), Some(c.id()));
        assert!(status(&t.0).unwrap().files.is_empty());

        assert_eq!(commit(&t.0, "again").unwrap_err().code, "nothing_to_commit");
        assert_eq!(commit(&t.0, "   ").unwrap_err().code, "empty_message");

        // Second commit gets the first as parent.
        fs::write(t.path("a.txt"), "b\n").unwrap();
        commit_all(&t, &["a.txt"], "second");
        let head = r.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_id(0).unwrap(), c.id());
    }

    #[test]
    fn outside_a_repo_is_not_repo() {
        let t = TempDir::new();
        assert_eq!(status(&t.0).unwrap_err().code, "not_repo");
    }

    #[test]
    fn paths_outside_the_repo_are_rejected() {
        let (t, _r) = repo();
        assert_eq!(
            stage(&t.0, &["/etc/hosts".into()]).unwrap_err().code,
            "invalid"
        );
    }
}
