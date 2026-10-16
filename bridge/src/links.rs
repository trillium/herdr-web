//! Links & notes handoff list: a place an agent can drop a URL or a short note so the human can
//! open it later from the `/links` page. Agents publish through `herdr-web-bridge link ...`
//! (see [`run_cli`]) or `POST /api/links`; both write the same file-locked JSON store.

use std::fs::{self, File};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::store_util::{
    copy_corrupt_once, default_store_dir, ensure_private_dir, now_ms_string,
    set_private_file_permissions, LockFile,
};

const LINKS_STORE_VERSION: u32 = 1;
/// Newest-first cap. Dismissed entries are evicted before any live one.
const MAX_ENTRIES: usize = 500;
const MAX_URL_CHARS: usize = 2_048;
const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_BYTES: usize = 16 * 1024;
const MAX_FIELD_CHARS: usize = 200;

#[derive(Clone)]
pub struct LinksManager {
    path: PathBuf,
    lock_path: PathBuf,
}

#[derive(Debug)]
pub enum LinksError {
    BadRequest(String),
    NotFound(String),
    Io(io::Error),
    Store(String),
}

impl std::fmt::Display for LinksError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message) | Self::NotFound(message) | Self::Store(message) => {
                write!(f, "{message}")
            }
            Self::Io(err) => write!(f, "{err}"),
        }
    }
}

impl From<io::Error> for LinksError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Link,
    Note,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkEntry {
    pub id: String,
    pub kind: LinkKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Free-text publisher label, e.g. the agent or task name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Pane the publisher ran in, when known (`HERDR_PANE_ID`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// How many times this URL was published; re-publishing a live link bumps it instead of
    /// adding a duplicate row.
    pub count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinksListResponse {
    pub entries: Vec<LinkEntry>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LinksListQuery {
    #[serde(default)]
    pub include_dismissed: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AddLinkRequest {
    pub url: Option<String>,
    pub body: Option<String>,
    pub title: Option<String>,
    pub source: Option<String>,
    pub pane_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LinksStore {
    version: u32,
    next_id: u64,
    created_at: String,
    updated_at: String,
    entries: Vec<LinkEntry>,
}

impl LinksManager {
    pub fn new() -> io::Result<Self> {
        let dir = default_links_dir();
        ensure_private_dir(&dir)?;
        Ok(Self {
            path: dir.join("links.json"),
            lock_path: dir.join("links.lock"),
        })
    }

    #[cfg(test)]
    fn for_test(dir: PathBuf) -> io::Result<Self> {
        ensure_private_dir(&dir)?;
        Ok(Self {
            path: dir.join("links.json"),
            lock_path: dir.join("links.lock"),
        })
    }

    /// Newest-updated first. Dismissed entries are hidden unless asked for.
    pub fn list(&self, query: LinksListQuery) -> Result<LinksListResponse, LinksError> {
        let _lock = LockFile::exclusive(&self.lock_path)?;
        let store = self.load_or_create_store()?;
        let mut entries: Vec<LinkEntry> = store
            .entries
            .into_iter()
            .filter(|entry| query.include_dismissed || entry.dismissed_at.is_none())
            .collect();
        entries.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(LinksListResponse { entries })
    }

    /// Adds a note, or a link. A live link with the same URL is bumped instead of duplicated.
    pub fn add(&self, request: AddLinkRequest) -> Result<LinkEntry, LinksError> {
        let draft = normalize_request(request)?;
        self.with_store(|store, now| {
            Ok(apply_add(store, now, draft, true).expect("bumping add always yields an entry"))
        })
    }

    /// Bulk-adds links found by a scanner. Unlike [`add`], a URL that is already present (live or
    /// dismissed) is left untouched (no bump, no "new" again), so re-running a sweep is idempotent. Invalid URLs are
    /// counted, not fatal.
    pub fn ingest(&self, requests: Vec<AddLinkRequest>) -> Result<IngestResult, LinksError> {
        let mut drafts = Vec::new();
        let mut invalid = 0;
        for request in requests {
            if request.url.is_none() {
                invalid += 1;
                continue;
            }
            match normalize_request(request) {
                Ok(draft) => drafts.push(draft),
                Err(_) => invalid += 1,
            }
        }
        self.with_store(|store, now| {
            let mut result = IngestResult {
                added: 0,
                already_present: 0,
                invalid,
            };
            for draft in drafts {
                match apply_add(store, now.clone(), draft, false) {
                    Some(_) => result.added += 1,
                    None => result.already_present += 1,
                }
            }
            Ok(result)
        })
    }

    pub fn mark_opened(&self, id: &str) -> Result<LinkEntry, LinksError> {
        self.update_entry(id, |entry, now| {
            if entry.opened_at.is_none() {
                entry.opened_at = Some(now);
            }
        })
    }

    pub fn dismiss(&self, id: &str) -> Result<LinkEntry, LinksError> {
        self.update_entry(id, |entry, now| {
            if entry.dismissed_at.is_none() {
                entry.dismissed_at = Some(now);
            }
        })
    }

    pub fn restore(&self, id: &str) -> Result<LinkEntry, LinksError> {
        self.update_entry(id, |entry, _| entry.dismissed_at = None)
    }

    fn update_entry<F>(&self, id: &str, change: F) -> Result<LinkEntry, LinksError>
    where
        F: FnOnce(&mut LinkEntry, String),
    {
        let id = id.trim().to_string();
        self.with_store(|store, now| {
            let entry = store
                .entries
                .iter_mut()
                .find(|entry| entry.id == id)
                .ok_or_else(|| LinksError::NotFound(format!("link not found: {id}")))?;
            change(entry, now);
            Ok(entry.clone())
        })
    }

    fn with_store<F, T>(&self, mutate: F) -> Result<T, LinksError>
    where
        F: FnOnce(&mut LinksStore, String) -> Result<T, LinksError>,
    {
        let _lock = LockFile::exclusive(&self.lock_path)?;
        let mut store = self.load_or_create_store()?;
        let now = now_ms_string();
        let result = mutate(&mut store, now.clone())?;
        store.updated_at = now;
        write_json_atomic(&self.path, &store)?;
        Ok(result)
    }

    fn load_or_create_store(&self) -> Result<LinksStore, LinksError> {
        match fs::read(&self.path) {
            Ok(bytes) => match parse_store(&bytes) {
                Ok(store) => Ok(store),
                Err(err) => {
                    copy_corrupt_once(&self.path);
                    Err(err)
                }
            },
            Err(err) if err.kind() == ErrorKind::NotFound => {
                let now = now_ms_string();
                Ok(LinksStore {
                    version: LINKS_STORE_VERSION,
                    next_id: 1,
                    created_at: now.clone(),
                    updated_at: now,
                    entries: Vec::new(),
                })
            }
            Err(err) => Err(LinksError::Io(err)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct IngestResult {
    pub added: usize,
    pub already_present: usize,
    pub invalid: usize,
}

struct Draft {
    url: Option<String>,
    body: Option<String>,
    title: String,
    title_given: bool,
    source: Option<String>,
    pane_id: Option<String>,
}

/// Returns the stored entry, or `None` when a live copy of the URL exists and `bump` is false.
fn apply_add(store: &mut LinksStore, now: String, draft: Draft, bump: bool) -> Option<LinkEntry> {
    if let Some(url) = &draft.url {
        if let Some(existing) = store.entries.iter_mut().find(|entry| {
            (!bump || entry.dismissed_at.is_none())
                && entry.kind == LinkKind::Link
                && entry.url.as_deref() == Some(url.as_str())
        }) {
            if !bump {
                return None;
            }
            existing.count += 1;
            existing.updated_at = now;
            existing.opened_at = None;
            if draft.title_given {
                existing.title = draft.title;
            }
            if draft.source.is_some() {
                existing.source = draft.source;
            }
            if draft.pane_id.is_some() {
                existing.pane_id = draft.pane_id;
            }
            return Some(existing.clone());
        }
    }
    let entry = LinkEntry {
        id: format!("l{}", store.next_id),
        kind: if draft.url.is_some() {
            LinkKind::Link
        } else {
            LinkKind::Note
        },
        title: draft.title,
        url: draft.url,
        body: draft.body,
        source: draft.source,
        pane_id: draft.pane_id,
        created_at: now.clone(),
        updated_at: now,
        count: 1,
        opened_at: None,
        dismissed_at: None,
    };
    store.next_id += 1;
    store.entries.push(entry.clone());
    prune(store);
    Some(entry)
}

fn normalize_request(request: AddLinkRequest) -> Result<Draft, LinksError> {
    let url = clean_optional(request.url.as_deref());
    let body = clean_optional(request.body.as_deref());
    if url.is_none() && body.is_none() {
        return Err(LinksError::BadRequest(
            "a link needs a url, a note needs a body".to_string(),
        ));
    }
    if let Some(url) = &url {
        validate_url(url)?;
    }
    if let Some(body) = &body {
        if body.len() > MAX_BODY_BYTES {
            return Err(LinksError::BadRequest(format!(
                "body is larger than {MAX_BODY_BYTES} bytes"
            )));
        }
    }
    let given_title = clean_optional(request.title.as_deref());
    let title_given = given_title.is_some();
    let title = match given_title {
        Some(title) => title,
        None => default_title(url.as_deref(), body.as_deref()),
    };
    Ok(Draft {
        url,
        body,
        title: truncate_chars(&title, MAX_TITLE_CHARS),
        title_given,
        source: clean_optional(request.source.as_deref())
            .map(|value| truncate_chars(&value, MAX_FIELD_CHARS)),
        pane_id: clean_optional(request.pane_id.as_deref())
            .map(|value| truncate_chars(&value, MAX_FIELD_CHARS)),
    })
}

/// Only plain http(s) URLs are accepted: the page renders them as clickable anchors, so
/// `javascript:` and friends must never get in.
fn validate_url(url: &str) -> Result<(), LinksError> {
    if url.chars().count() > MAX_URL_CHARS {
        return Err(LinksError::BadRequest(format!(
            "url is longer than {MAX_URL_CHARS} characters"
        )));
    }
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| LinksError::BadRequest("url must start with http:// or https://".into()))?;
    if rest.is_empty() || rest.starts_with('/') {
        return Err(LinksError::BadRequest("url is missing a host".to_string()));
    }
    if url.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return Err(LinksError::BadRequest(
            "url must not contain whitespace or control characters".to_string(),
        ));
    }
    Ok(())
}

fn default_title(url: Option<&str>, body: Option<&str>) -> String {
    if let Some(body) = body {
        if let Some(line) = body.lines().map(str::trim).find(|line| !line.is_empty()) {
            return line.to_string();
        }
    }
    url.map(|url| url_host(url).to_string())
        .unwrap_or_else(|| "Untitled".to_string())
}

fn url_host(url: &str) -> &str {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    rest.split(['/', '?', '#']).next().unwrap_or(rest)
}

fn clean_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn prune(store: &mut LinksStore) {
    if store.entries.len() <= MAX_ENTRIES {
        return;
    }
    // Keep live entries first, then newest; the oldest dismissed rows go first.
    store.entries.sort_by(|a, b| {
        a.dismissed_at
            .is_some()
            .cmp(&b.dismissed_at.is_some())
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    store.entries.truncate(MAX_ENTRIES);
}

fn parse_store(bytes: &[u8]) -> Result<LinksStore, LinksError> {
    let store: LinksStore = serde_json::from_slice(bytes)
        .map_err(|err| LinksError::Store(format!("links store is unreadable: {err}")))?;
    if store.version != LINKS_STORE_VERSION {
        return Err(LinksError::Store(format!(
            "unsupported links store version: {}",
            store.version
        )));
    }
    Ok(store)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), LinksError> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent)?;
    }
    let temp_path = path.with_extension(format!("{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|err| LinksError::Store(format!("failed to serialize links: {err}")))?;
    let mut file = File::create(&temp_path)?;
    set_private_file_permissions(&temp_path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp_path, path)?;
    set_private_file_permissions(path)?;
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn default_links_dir() -> PathBuf {
    default_store_dir("HERDR_WEB_LINKS_DIR", "links", "herdr-web-links")
}

const CLI_USAGE: &str = "\
usage: herdr-web-bridge link URL [--title TEXT] [--source TEXT] [--pane ID]
       herdr-web-bridge link --note TEXT|- [--title TEXT] [--source TEXT] [--pane ID]
       herdr-web-bridge link --list [--all] [--json]
       herdr-links --json | herdr-web-bridge link --from-herdr-links

Publishes a URL or a short note to the herdr-web /links page. `--note -` reads the note from stdin.
--from-herdr-links reads the JSON that `herdr-links --json` prints on stdin and publishes every URL it
found, skipping ones already on the page. --pane defaults to $HERDR_PANE_ID. The store lives under $HERDR_WEB_LINKS_DIR or
~/.local/share/herdr-web/links, the same place the running bridge reads.";

/// `herdr-web-bridge link ...`: the agent-facing CLI. Returns the process exit code.
pub(crate) fn run_cli(args: &[String]) -> io::Result<i32> {
    let manager = LinksManager::new()?;
    Ok(run_cli_with(
        &manager,
        args,
        &mut io::stdin(),
        &mut io::stdout(),
        &mut io::stderr(),
    ))
}

fn run_cli_with(
    manager: &LinksManager,
    args: &[String],
    stdin: &mut dyn Read,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let parsed = match parse_cli(args) {
        Ok(Some(parsed)) => parsed,
        Ok(None) => {
            let _ = writeln!(out, "{CLI_USAGE}");
            return 0;
        }
        Err(message) => {
            let _ = writeln!(err, "{message}\n{CLI_USAGE}");
            return 2;
        }
    };

    if parsed.list {
        return match manager.list(LinksListQuery {
            include_dismissed: parsed.all,
        }) {
            Ok(response) if parsed.json => {
                let _ = writeln!(
                    out,
                    "{}",
                    serde_json::to_string(&response).unwrap_or_default()
                );
                0
            }
            Ok(response) => {
                for entry in &response.entries {
                    let target = entry.url.as_deref().unwrap_or("(note)");
                    let _ = writeln!(out, "{}\t{}\t{}", entry.id, target, entry.title);
                }
                0
            }
            Err(error) => {
                let _ = writeln!(err, "link: {error}");
                1
            }
        };
    }

    if parsed.from_herdr_links {
        return run_ingest(manager, &parsed, stdin, out, err);
    }

    let mut request = AddLinkRequest {
        url: parsed.url,
        body: parsed.note,
        title: parsed.title,
        source: parsed.source,
        pane_id: parsed.pane.or_else(|| std::env::var("HERDR_PANE_ID").ok()),
    };
    if request.body.as_deref() == Some("-") {
        let mut text = String::new();
        if let Err(error) = stdin
            .take(MAX_BODY_BYTES as u64 + 1)
            .read_to_string(&mut text)
        {
            let _ = writeln!(err, "link: could not read stdin: {error}");
            return 1;
        }
        request.body = Some(text);
    }
    match manager.add(request) {
        Ok(entry) if parsed.json => {
            let _ = writeln!(out, "{}", serde_json::to_string(&entry).unwrap_or_default());
            0
        }
        Ok(entry) => {
            let _ = writeln!(
                out,
                "published {} {}: {}",
                entry.id,
                match entry.kind {
                    LinkKind::Link => "link",
                    LinkKind::Note => "note",
                },
                entry.url.as_deref().unwrap_or(&entry.title)
            );
            0
        }
        Err(LinksError::BadRequest(message)) => {
            let _ = writeln!(err, "link: {message}");
            2
        }
        Err(error) => {
            let _ = writeln!(err, "link: {error}");
            1
        }
    }
}

/// Subset of `herdr-links --json` we read: `all_urls[].url` plus the panes each URL was seen in.
#[derive(Deserialize)]
struct HerdrLinksOutput {
    #[serde(default)]
    all_urls: Vec<HerdrLinksUrl>,
}

#[derive(Deserialize)]
struct HerdrLinksUrl {
    url: String,
    #[serde(default)]
    panes: Vec<String>,
}

fn run_ingest(
    manager: &LinksManager,
    parsed: &CliArgs,
    stdin: &mut dyn Read,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let mut text = String::new();
    // herdr-links output for a busy session is tens of KiB; cap well above that.
    if let Err(error) = stdin.take(8 * 1024 * 1024).read_to_string(&mut text) {
        let _ = writeln!(err, "link: could not read stdin: {error}");
        return 1;
    }
    let scanned: HerdrLinksOutput = match serde_json::from_str(&text) {
        Ok(scanned) => scanned,
        Err(error) => {
            let _ = writeln!(
                err,
                "link: stdin is not `herdr-links --json` output: {error}"
            );
            return 2;
        }
    };
    let source = parsed
        .source
        .clone()
        .unwrap_or_else(|| "herdr-links".to_string());
    let requests = scanned
        .all_urls
        .into_iter()
        .map(|found| AddLinkRequest {
            url: Some(found.url),
            source: Some(source.clone()),
            pane_id: found.panes.into_iter().next(),
            ..Default::default()
        })
        .collect();
    match manager.ingest(requests) {
        Ok(result) if parsed.json => {
            let _ = writeln!(
                out,
                "{}",
                serde_json::to_string(&result).unwrap_or_default()
            );
            0
        }
        Ok(result) => {
            let _ = writeln!(
                out,
                "published {} new link(s); {} already on the page, {} skipped as invalid",
                result.added, result.already_present, result.invalid
            );
            0
        }
        Err(error) => {
            let _ = writeln!(err, "link: {error}");
            1
        }
    }
}

#[derive(Default)]
struct CliArgs {
    url: Option<String>,
    note: Option<String>,
    title: Option<String>,
    source: Option<String>,
    pane: Option<String>,
    list: bool,
    from_herdr_links: bool,
    all: bool,
    json: bool,
}

fn parse_cli(args: &[String]) -> Result<Option<CliArgs>, String> {
    let mut parsed = CliArgs::default();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let mut value = |name: &str| -> Result<String, String> {
            index += 1;
            args.get(index)
                .cloned()
                .ok_or_else(|| format!("missing value for {name}"))
        };
        match arg {
            "-h" | "--help" => return Ok(None),
            "--note" => parsed.note = Some(value("--note")?),
            "--title" => parsed.title = Some(value("--title")?),
            "--source" => parsed.source = Some(value("--source")?),
            "--pane" => parsed.pane = Some(value("--pane")?),
            "--list" => parsed.list = true,
            "--from-herdr-links" => parsed.from_herdr_links = true,
            "--all" => parsed.all = true,
            "--json" => parsed.json = true,
            other if other.starts_with("--") => return Err(format!("unknown option: {other}")),
            other => {
                if parsed.url.is_some() {
                    return Err(format!("unexpected argument: {other}"));
                }
                parsed.url = Some(other.to_string());
            }
        }
        index += 1;
    }
    if parsed.from_herdr_links && (parsed.url.is_some() || parsed.note.is_some() || parsed.list) {
        return Err("--from-herdr-links takes no URL, --note or --list".to_string());
    }
    if !parsed.list && !parsed.from_herdr_links && parsed.url.is_none() && parsed.note.is_none() {
        return Err("give a URL or --note TEXT".to_string());
    }
    Ok(Some(parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager(name: &str) -> LinksManager {
        let dir = std::env::temp_dir().join(format!(
            "herdr-web-links-test-{name}-{}-{}",
            std::process::id(),
            now_ms_string()
        ));
        LinksManager::for_test(dir).unwrap()
    }

    fn link(url: &str) -> AddLinkRequest {
        AddLinkRequest {
            url: Some(url.to_string()),
            ..Default::default()
        }
    }

    fn list_all(manager: &LinksManager) -> Vec<LinkEntry> {
        manager
            .list(LinksListQuery {
                include_dismissed: true,
            })
            .unwrap()
            .entries
    }

    #[test]
    fn adds_a_link_with_host_as_default_title() {
        let manager = manager("add-link");
        let entry = manager.add(link("https://example.com/a/b?x=1")).unwrap();

        assert_eq!(entry.kind, LinkKind::Link);
        assert_eq!(entry.title, "example.com");
        assert_eq!(entry.count, 1);
        assert_eq!(
            manager
                .list(LinksListQuery::default())
                .unwrap()
                .entries
                .len(),
            1
        );
    }

    #[test]
    fn adds_a_note_titled_by_its_first_line() {
        let manager = manager("add-note");
        let entry = manager
            .add(AddLinkRequest {
                body: Some("\n  deploy done\nsecond line".to_string()),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(entry.kind, LinkKind::Note);
        assert_eq!(entry.title, "deploy done");
        assert!(entry.url.is_none());
    }

    #[test]
    fn rejects_non_http_urls_and_empty_requests() {
        let manager = manager("reject");
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://",
            "https:///path",
            "http://a b.com",
            "ftp://example.com",
        ] {
            assert!(
                matches!(manager.add(link(bad)), Err(LinksError::BadRequest(_))),
                "{bad} should be rejected"
            );
        }
        assert!(matches!(
            manager.add(AddLinkRequest::default()),
            Err(LinksError::BadRequest(_))
        ));
        assert!(list_all(&manager).is_empty());
    }

    #[test]
    fn republishing_a_live_url_bumps_it_instead_of_duplicating() {
        let manager = manager("dedupe");
        let first = manager.add(link("https://example.com/x")).unwrap();
        manager.mark_opened(&first.id).unwrap();
        let again = manager
            .add(AddLinkRequest {
                title: Some("Better title".to_string()),
                ..link("https://example.com/x")
            })
            .unwrap();

        assert_eq!(again.id, first.id);
        assert_eq!(again.count, 2);
        assert_eq!(again.title, "Better title");
        assert!(again.opened_at.is_none(), "a republished link is new again");
        assert_eq!(list_all(&manager).len(), 1);
    }

    #[test]
    fn dismissed_links_do_not_absorb_a_new_publish() {
        let manager = manager("dedupe-dismissed");
        let first = manager.add(link("https://example.com/x")).unwrap();
        manager.dismiss(&first.id).unwrap();
        let second = manager.add(link("https://example.com/x")).unwrap();

        assert_ne!(first.id, second.id);
        assert_eq!(
            manager
                .list(LinksListQuery::default())
                .unwrap()
                .entries
                .len(),
            1
        );
        assert_eq!(list_all(&manager).len(), 2);
    }

    #[test]
    fn open_dismiss_and_restore_update_state() {
        let manager = manager("state");
        let entry = manager.add(link("https://example.com/")).unwrap();

        assert!(manager.mark_opened(&entry.id).unwrap().opened_at.is_some());
        assert!(manager.dismiss(&entry.id).unwrap().dismissed_at.is_some());
        assert!(manager
            .list(LinksListQuery::default())
            .unwrap()
            .entries
            .is_empty());
        assert!(manager.restore(&entry.id).unwrap().dismissed_at.is_none());
        assert!(matches!(
            manager.dismiss("nope"),
            Err(LinksError::NotFound(_))
        ));
    }

    #[test]
    fn ingest_does_not_resurrect_dismissed_links() {
        let manager = manager("ingest-dismissed");
        let first = manager.ingest(vec![link("https://example.com/a")]).unwrap();
        assert_eq!(first.added, 1);
        let id = list_all(&manager)[0].id.clone();
        manager.dismiss(&id).unwrap();

        let again = manager.ingest(vec![link("https://example.com/a")]).unwrap();
        assert_eq!(again.added, 0);
        assert_eq!(again.already_present, 1);
        assert!(manager
            .list(LinksListQuery::default())
            .unwrap()
            .entries
            .is_empty());
        let all = list_all(&manager);
        assert_eq!(all.len(), 1);
        assert!(all[0].dismissed_at.is_some());
        assert_eq!(all[0].count, 1);
    }

    #[test]
    fn list_is_newest_first() {
        let manager = manager("order");
        let a = manager.add(link("https://a.example/")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        let b = manager.add(link("https://b.example/")).unwrap();

        let ids: Vec<String> = list_all(&manager).into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![b.id, a.id]);
    }

    #[test]
    fn prune_drops_dismissed_entries_before_live_ones() {
        let mut store = LinksStore {
            version: LINKS_STORE_VERSION,
            next_id: 1,
            created_at: "0".into(),
            updated_at: "0".into(),
            entries: Vec::new(),
        };
        for n in 0..(MAX_ENTRIES + 5) {
            store.entries.push(LinkEntry {
                id: format!("l{n}"),
                kind: LinkKind::Link,
                title: "t".into(),
                url: Some(format!("https://e.example/{n}")),
                body: None,
                source: None,
                pane_id: None,
                created_at: format!("{:013}", n),
                updated_at: format!("{:013}", n),
                count: 1,
                opened_at: None,
                // The very newest rows are dismissed; they must still be the ones to go.
                dismissed_at: (n >= MAX_ENTRIES).then(|| "1".to_string()),
            });
        }
        prune(&mut store);

        assert_eq!(store.entries.len(), MAX_ENTRIES);
        assert!(store.entries.iter().all(|e| e.dismissed_at.is_none()));
    }

    #[test]
    fn corrupt_store_is_copied_aside_before_error() {
        let manager = manager("corrupt");
        fs::write(&manager.path, b"{not json").unwrap();

        assert!(manager.list(LinksListQuery::default()).is_err());
        assert!(crate::store_util::corrupt_copy_exists(&manager.path));
    }

    fn run(manager: &LinksManager, args: &[&str], stdin: &str) -> (i32, String, String) {
        let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run_cli_with(manager, &args, &mut stdin.as_bytes(), &mut out, &mut err);
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    #[test]
    fn cli_publishes_a_link_and_lists_it() {
        let manager = manager("cli-link");
        let (code, out, _) = run(
            &manager,
            &[
                "https://example.com/pr/1",
                "--title",
                "PR 1",
                "--source",
                "agent-x",
            ],
            "",
        );
        assert_eq!(code, 0);
        assert!(
            out.contains("published l1 link: https://example.com/pr/1"),
            "{out}"
        );

        let (code, out, _) = run(&manager, &["--list"], "");
        assert_eq!(code, 0);
        assert_eq!(out, "l1\thttps://example.com/pr/1\tPR 1\n");

        let entry = &list_all(&manager)[0];
        assert_eq!(entry.source.as_deref(), Some("agent-x"));
    }

    #[test]
    fn cli_reads_a_note_from_stdin() {
        let manager = manager("cli-note");
        let (code, out, _) = run(&manager, &["--note", "-"], "tests pass\nship it\n");
        assert_eq!(code, 0);
        assert!(out.contains("note"), "{out}");
        let entry = &list_all(&manager)[0];
        assert_eq!(entry.title, "tests pass");
        assert_eq!(entry.body.as_deref(), Some("tests pass\nship it"));
    }

    const HERDR_LINKS_JSON: &str = r#"{
        "focused_pane": "wY5:p11",
        "panes": [],
        "all_urls": [
            {"url": "https://github.com/trillium/parlay/pull/334", "panes": ["wY5:p3", "wY5:p6"], "total_count": 3},
            {"url": "http://100.1.2.3:8765", "panes": ["wY5:pG"], "total_count": 1},
            {"url": "javascript:alert(1)", "panes": ["wY5:pH"], "total_count": 1}
        ]
    }"#;

    #[test]
    fn cli_ingests_herdr_links_json_idempotently() {
        let manager = manager("cli-ingest");
        let (code, out, _) = run(&manager, &["--from-herdr-links"], HERDR_LINKS_JSON);
        assert_eq!(code, 0);
        assert_eq!(
            out,
            "published 2 new link(s); 0 already on the page, 1 skipped as invalid\n"
        );

        let entries = list_all(&manager);
        assert_eq!(entries.len(), 2);
        let pr = entries
            .iter()
            .find(|entry| {
                entry.url.as_deref() == Some("https://github.com/trillium/parlay/pull/334")
            })
            .unwrap();
        assert_eq!(pr.source.as_deref(), Some("herdr-links"));
        assert_eq!(pr.pane_id.as_deref(), Some("wY5:p3"));

        // A link the human already opened must not turn "new" again on the next sweep.
        manager.mark_opened(&pr.id).unwrap();
        let (_, out, _) = run(
            &manager,
            &["--from-herdr-links", "--json"],
            HERDR_LINKS_JSON,
        );
        let value: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(value["added"], 0);
        assert_eq!(value["already_present"], 2);
        let pr = list_all(&manager)
            .into_iter()
            .find(|e| e.id == pr.id)
            .unwrap();
        assert!(pr.opened_at.is_some());
        assert_eq!(pr.count, 1);
    }

    #[test]
    fn cli_ingest_rejects_other_input() {
        let manager = manager("cli-ingest-bad");
        assert_eq!(run(&manager, &["--from-herdr-links"], "not json").0, 2);
        assert_eq!(
            run(
                &manager,
                &["--from-herdr-links", "https://example.com/"],
                "{}"
            )
            .0,
            2
        );
        assert_eq!(run(&manager, &["--from-herdr-links"], "{}").0, 0);
        assert!(list_all(&manager).is_empty());
    }

    #[test]
    fn cli_reports_usage_errors_with_exit_two() {
        let manager = manager("cli-errors");
        assert_eq!(run(&manager, &[], "").0, 2);
        assert_eq!(run(&manager, &["--bogus"], "").0, 2);
        assert_eq!(run(&manager, &["javascript:alert(1)"], "").0, 2);
        assert_eq!(run(&manager, &["--help"], "").0, 0);
    }

    #[test]
    fn cli_json_output_is_one_parseable_line() {
        let manager = manager("cli-json");
        let (_, out, _) = run(&manager, &["https://example.com/", "--json"], "");
        let value: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(value["url"], "https://example.com/");
        assert_eq!(value["kind"], "link");
    }
}
