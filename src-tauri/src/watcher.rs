use crate::error::AppError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_millis(100);

/// Canonical watched directory -> (root as the frontend named it, watch count).
type Roots = Arc<Mutex<HashMap<PathBuf, (String, usize)>>>;

/// Watches single directories (never recursively, so `node_modules` is never walked) and
/// reports changes per watched root, debounced to 100 ms. Watches are reference counted:
/// the tree and an open file can both watch the same folder.
pub struct Watcher {
    inner: Mutex<RecommendedWatcher>,
    roots: Roots,
}

impl Watcher {
    pub fn new(on_change: impl Fn(String, Vec<String>) + Send + 'static) -> Result<Self, AppError> {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let inner = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                for p in event.paths {
                    let _ = tx.send(p);
                }
            }
        })
        .map_err(AppError::io)?;
        let roots: Roots = Arc::default();

        let watched = roots.clone();
        thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut batch = vec![first];
                let deadline = Instant::now() + DEBOUNCE;
                while let Ok(p) =
                    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                {
                    batch.push(p);
                }
                let mut changed: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
                {
                    let roots = watched.lock().unwrap();
                    for p in &batch {
                        // An event is about a direct child of a watched folder, or the folder itself.
                        let dir = [p.parent(), Some(p.as_path())]
                            .into_iter()
                            .flatten()
                            .find(|d| roots.contains_key(*d));
                        if let Some(dir) = dir {
                            let root = &roots[dir].0;
                            let shown = match p.strip_prefix(dir) {
                                Ok(rel) if !rel.as_os_str().is_empty() => Path::new(root).join(rel),
                                _ => PathBuf::from(root),
                            };
                            changed
                                .entry(root.clone())
                                .or_default()
                                .insert(shown.to_string_lossy().into_owned());
                        }
                    }
                }
                for (root, paths) in changed {
                    on_change(root, paths.into_iter().collect());
                }
            }
        });

        Ok(Self {
            inner: Mutex::new(inner),
            roots,
        })
    }

    pub fn watch(&self, root: &str) -> Result<(), AppError> {
        // Events arrive with canonical paths (macOS reports /private/var for /var).
        let canonical = std::fs::canonicalize(root)?;
        let mut roots = self.roots.lock().unwrap();
        if let Some(entry) = roots.get_mut(&canonical) {
            entry.1 += 1;
            return Ok(());
        }
        self.inner
            .lock()
            .unwrap()
            .watch(&canonical, RecursiveMode::NonRecursive)
            .map_err(AppError::io)?;
        roots.insert(canonical, (root.to_string(), 1));
        Ok(())
    }

    pub fn unwatch(&self, root: &str) -> Result<(), AppError> {
        let mut roots = self.roots.lock().unwrap();
        // The folder may already be gone; then find it by the name it was watched under.
        let key = std::fs::canonicalize(root)
            .ok()
            .filter(|c| roots.contains_key(c))
            .or_else(|| {
                roots
                    .iter()
                    .find(|(_, (r, _))| r == root)
                    .map(|(k, _)| k.clone())
            })
            .ok_or_else(|| AppError::new("not_found", format!("{root} is not watched")))?;
        let entry = roots.get_mut(&key).expect("key found above");
        entry.1 -= 1;
        if entry.1 == 0 {
            roots.remove(&key);
            let _ = self.inner.lock().unwrap().unwatch(&key);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::tests::TempDir;
    use std::sync::mpsc::Receiver;

    fn watcher() -> (Watcher, Receiver<(String, Vec<String>)>) {
        let (tx, rx) = mpsc::channel();
        let w = Watcher::new(move |root, paths| {
            let _ = tx.send((root, paths));
        })
        .unwrap();
        (w, rx)
    }

    fn wait_for_path(rx: &Receiver<(String, Vec<String>)>, root: &str, path: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok((r, paths)) = rx.recv_timeout(Duration::from_millis(200))
                && r == root
                && paths.iter().any(|p| p == path)
            {
                return;
            }
        }
        panic!("no fs-changed event for {path} under {root}");
    }

    #[test]
    fn reports_changes_under_the_root_as_named() {
        let t = TempDir::new();
        let (w, rx) = watcher();
        let root = t.0.to_string_lossy().into_owned();
        w.watch(&root).unwrap();
        // Give FSEvents a moment to start before the first change.
        thread::sleep(Duration::from_millis(300));
        std::fs::write(t.path("new.txt"), "x").unwrap();
        wait_for_path(&rx, &root, &format!("{root}/new.txt"));
    }

    #[test]
    fn watches_are_reference_counted() {
        let t = TempDir::new();
        let (w, _rx) = watcher();
        let root = t.0.to_string_lossy().into_owned();
        w.watch(&root).unwrap();
        w.watch(&root).unwrap();
        w.unwatch(&root).unwrap();
        assert!(
            w.roots
                .lock()
                .unwrap()
                .values()
                .any(|(r, n)| r == &root && *n == 1)
        );
        w.unwatch(&root).unwrap();
        assert!(w.roots.lock().unwrap().is_empty());
        assert_eq!(w.unwatch(&root).unwrap_err().code, "not_found");
    }

    #[test]
    fn watch_of_missing_folder_fails() {
        let t = TempDir::new();
        let (w, _rx) = watcher();
        assert_eq!(
            w.watch(&t.path("nope").to_string_lossy()).unwrap_err().code,
            "not_found"
        );
    }
}
