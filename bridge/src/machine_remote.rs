//! Herdr saved machines as remotes (`--remote-machine <label>`).
//!
//! A `--remote-bridge` remote needs a herdr-web bridge running on the far side. A machine remote
//! needs nothing there: it is a machine saved in this host's herdr registry (`herdr machine
//! list`), and every read and write goes through herdr's own machine API,
//! `herdr --machine <label> <api command>`, which runs over SSH. The web UI sees it under the same
//! `/api/remote/<id>/...` and `/ws/remote/<id>/terminal` shape as any other remote.
//!
//! Herdr's machine API is request/response only: there is no streaming or watch command, so a
//! terminal is a poll of `pane read --source visible --ansi` repainted to the browser whenever the
//! screen changed. One poller per (machine, pane) is shared by every websocket watching it.

use std::collections::{HashMap, HashSet};
use std::process::{Command, Stdio};
use std::sync::{mpsc as std_mpsc, Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use bytes::Bytes;
use herdr_compat::api::schema::{ResponseResult, SessionSnapshot, SuccessResponse};
use tokio::sync::{mpsc, watch, Notify};
use tokio::task::JoinHandle;
use tracing::{debug, warn};

/// Upper bound on one `herdr --machine ...` invocation (SSH connect included).
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a fetched snapshot is reused, so a UI refresh burst costs one SSH round trip.
const SNAPSHOT_TTL: Duration = Duration::from_millis(1200);
/// Pane poll cadence while nothing was typed recently / right after input.
const POLL_IDLE: Duration = Duration::from_millis(1000);
const POLL_ACTIVE: Duration = Duration::from_millis(350);
const ACTIVE_WINDOW: Duration = Duration::from_secs(4);
/// Consecutive failed polls before the websocket is closed so the browser reconnects.
const MAX_POLL_FAILURES: u32 = 5;
const MAX_LABEL_LEN: usize = 64;

/// A herdr saved machine this bridge exposes as a remote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteMachine {
    /// Stable URL-safe id (`/api/remote/<id>/...`), shares its namespace with remote bridge ids.
    pub(crate) id: String,
    /// The saved machine label, exactly as `herdr --machine <label>` takes it.
    pub(crate) label: String,
}

impl RemoteMachine {
    /// Display-only URL, for `/api/bridges`. Nothing connects to it.
    pub(crate) fn display_url(&self) -> String {
        format!("herdr-machine://{}", self.id)
    }
}

/// Validates a `--remote-machine` value. The label is handed to herdr as an argument (never a
/// shell string), so this only rejects what herdr's own parser would misread.
pub(crate) fn normalize_machine_label(value: &str) -> Result<String, String> {
    let label = value.trim();
    if label.is_empty() {
        return Err("remote machine label must not be empty".into());
    }
    if label.len() > MAX_LABEL_LEN {
        return Err(format!(
            "remote machine label must be {MAX_LABEL_LEN} characters or fewer"
        ));
    }
    if label.starts_with('-') || label.chars().any(char::is_control) {
        return Err(
            "remote machine label must not start with '-' or contain control characters".into(),
        );
    }
    Ok(label.to_string())
}

/// Assigns each configured label an id, dropping duplicate labels and steering clear of ids the
/// remote bridges already use.
pub(crate) fn build_remote_machines(
    labels: &[String],
    taken_ids: &HashSet<String>,
) -> Vec<RemoteMachine> {
    let mut seen_labels = HashSet::new();
    let mut used_ids = taken_ids.clone();
    let mut machines = Vec::new();
    for label in labels {
        if !seen_labels.insert(label.clone()) {
            continue;
        }
        let slug: String = label
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() {
                    ch.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect();
        let base_id = if slug.chars().all(|ch| ch == '-') {
            "machine".to_string()
        } else {
            slug
        };
        let mut id = base_id.clone();
        let mut suffix = 2;
        while used_ids.contains(&id) {
            id = format!("{base_id}-{suffix}");
            suffix += 1;
        }
        used_ids.insert(id.clone());
        machines.push(RemoteMachine {
            id,
            label: label.clone(),
        });
    }
    machines
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MachineError {
    /// Herdr's API error code (`pane_not_found`, ...) when herdr answered with one.
    pub(crate) code: Option<String>,
    pub(crate) message: String,
}

impl MachineError {
    fn plain(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    fn is_pane_gone(&self) -> bool {
        self.code.as_deref() == Some("pane_not_found")
    }
}

impl std::fmt::Display for MachineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// Runs one herdr API command on a saved machine and returns its stdout. A seam for tests.
pub(crate) trait MachineRunner: Send + Sync + 'static {
    fn run(&self, machine: &str, args: &[&str]) -> Result<String, MachineError>;
}

/// The real runner: the local `herdr` binary (`HERDR_WEB_HERDR_BIN`, default `herdr` on PATH).
pub(crate) struct HerdrCli {
    bin: String,
}

impl HerdrCli {
    pub(crate) fn from_env() -> Self {
        Self {
            bin: std::env::var("HERDR_WEB_HERDR_BIN")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "herdr".to_string()),
        }
    }
}

impl MachineRunner for HerdrCli {
    fn run(&self, machine: &str, args: &[&str]) -> Result<String, MachineError> {
        let child = Command::new(&self.bin)
            .arg("--machine")
            .arg(machine)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| MachineError::plain(format!("failed to run {}: {err}", self.bin)))?;
        let pid = child.id();
        let (tx, rx) = std_mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        let output = match rx.recv_timeout(COMMAND_TIMEOUT) {
            Ok(Ok(output)) => output,
            Ok(Err(err)) => return Err(MachineError::plain(format!("herdr failed: {err}"))),
            Err(_) => {
                #[cfg(unix)]
                // SAFETY: plain signal to the child this call spawned; a stale pid at worst
                // makes kill() fail with ESRCH.
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGKILL);
                }
                #[cfg(not(unix))]
                let _ = pid;
                return Err(MachineError::plain(format!(
                    "herdr --machine {machine} timed out after {}s",
                    COMMAND_TIMEOUT.as_secs()
                )));
            }
        };
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        if output.status.success() {
            return Ok(stdout);
        }
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        Err(parse_cli_failure(&stdout, &stderr))
    }
}

/// Herdr reports API failures as `{"error":{"code","message"}}` (on stderr today); anything else
/// (unknown machine, SSH failure) is plain text.
fn parse_cli_failure(stdout: &str, stderr: &str) -> MachineError {
    for text in [stderr, stdout] {
        let first_line = text.trim().lines().next().unwrap_or("");
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(first_line) {
            if let Some(error) = value.get("error") {
                return MachineError {
                    code: error
                        .get("code")
                        .and_then(|code| code.as_str())
                        .map(str::to_string),
                    message: error
                        .get("message")
                        .and_then(|message| message.as_str())
                        .unwrap_or("herdr API error")
                        .to_string(),
                };
            }
        }
    }
    let text = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    MachineError::plain(if text.is_empty() {
        "herdr exited with an error".to_string()
    } else {
        text.to_string()
    })
}

/// Parses `herdr --machine X api snapshot` output into the session snapshot.
pub(crate) fn parse_snapshot_output(output: &str) -> Result<SessionSnapshot, MachineError> {
    let response: SuccessResponse = serde_json::from_str(output.trim())
        .map_err(|err| MachineError::plain(format!("unexpected herdr snapshot response: {err}")))?;
    match response.result {
        ResponseResult::SessionSnapshot { snapshot } => Ok(*snapshot),
        other => Err(MachineError::plain(format!(
            "unexpected herdr snapshot result: {other:?}"
        ))),
    }
}

/// Finds the pane showing a terminal. Pane ids (`w1:p3`) are what herdr's pane commands take;
/// the browser addresses terminals by `terminal_id`.
pub(crate) fn pane_id_for_terminal(
    snapshot: &SessionSnapshot,
    terminal_id: &str,
) -> Option<String> {
    snapshot
        .panes
        .iter()
        .find(|pane| pane.terminal_id == terminal_id)
        .map(|pane| pane.pane_id.clone())
}

/// `/api/remote/<id>/capabilities` for a machine remote: nothing beyond snapshot + terminal.
/// Notes, pins, activity and presets are bridge features; a bare herdr has none of them.
pub(crate) fn capabilities_json() -> serde_json::Value {
    serde_json::json!({
        "bridge_version": env!("CARGO_PKG_VERSION"),
        "web_compat": 1,
        "commands": [],
    })
}

/// One unit of browser input, in the order it was typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InputOp {
    /// Literal text for `pane send-text`.
    Text(String),
    /// Key names for `pane send-keys`.
    Keys(Vec<String>),
}

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

/// Translates the raw bytes an xterm emits into herdr send operations. Printable runs become one
/// `send-text`; control bytes and escape sequences become named keys, consecutive keys merged
/// into one call. A bracketed paste is kept as literal text (newlines included) so a multi-line
/// paste does not press Enter per line.
///
/// Herdr's key list has no Home/End/PageUp/PageDown/Delete/Insert, so those sequences are
/// dropped rather than guessed at.
pub(crate) fn input_ops(data: &str) -> Vec<InputOp> {
    let mut ops: Vec<InputOp> = Vec::new();
    let mut text = String::new();
    let chars: Vec<char> = data.chars().collect();
    let mut in_paste = false;
    let mut i = 0;

    fn flush_text(ops: &mut Vec<InputOp>, text: &mut String) {
        if !text.is_empty() {
            ops.push(InputOp::Text(std::mem::take(text)));
        }
    }
    fn push_key(ops: &mut Vec<InputOp>, text: &mut String, key: String) {
        flush_text(ops, text);
        match ops.last_mut() {
            Some(InputOp::Keys(keys)) => keys.push(key),
            _ => ops.push(InputOp::Keys(vec![key])),
        }
    }

    while i < chars.len() {
        let rest: String = chars[i..chars.len().min(i + 6)].iter().collect();
        if rest.starts_with(PASTE_START) {
            in_paste = true;
            i += PASTE_START.chars().count();
            continue;
        }
        if rest.starts_with(PASTE_END) {
            in_paste = false;
            i += PASTE_END.chars().count();
            continue;
        }
        let ch = chars[i];
        if in_paste {
            match ch {
                '\r' => {
                    text.push('\n');
                    if chars.get(i + 1) == Some(&'\n') {
                        i += 1;
                    }
                }
                _ => text.push(ch),
            }
            i += 1;
            continue;
        }
        match ch {
            '\x1b' => {
                let (consumed, key) = escape_sequence(&chars[i..]);
                if let Some(key) = key {
                    push_key(&mut ops, &mut text, key);
                }
                i += consumed;
                continue;
            }
            '\r' | '\n' => {
                push_key(&mut ops, &mut text, "enter".to_string());
                if ch == '\r' && chars.get(i + 1) == Some(&'\n') {
                    i += 1;
                }
            }
            '\t' => push_key(&mut ops, &mut text, "tab".to_string()),
            '\x7f' | '\x08' => push_key(&mut ops, &mut text, "backspace".to_string()),
            '\x01'..='\x1a' => {
                let letter = (b'a' + (ch as u8 - 1)) as char;
                push_key(&mut ops, &mut text, format!("ctrl+{letter}"));
            }
            ch if ch.is_control() => {}
            ch => text.push(ch),
        }
        i += 1;
    }
    flush_text(&mut ops, &mut text);
    ops
}

/// Decodes one escape sequence at the start of `chars` (which begins with ESC). Returns how many
/// chars it spans and the herdr key it maps to, if any.
fn escape_sequence(chars: &[char]) -> (usize, Option<String>) {
    let Some(&next) = chars.get(1) else {
        return (1, Some("esc".to_string()));
    };
    match next {
        // SS3: application cursor keys and F1-F4.
        'O' => match chars.get(2) {
            Some(&c @ ('A' | 'B' | 'C' | 'D')) => (3, Some(arrow_key(c).to_string())),
            Some(&c @ ('P' | 'Q' | 'R' | 'S')) => (3, Some(format!("f{}", c as u8 - b'P' + 1))),
            _ => (2, None),
        },
        // CSI: ESC [ params final.
        '[' => {
            let mut end = 2;
            while chars
                .get(end)
                .is_some_and(|c| ('\x30'..='\x3f').contains(c))
            {
                end += 1;
            }
            let Some(&final_char) = chars.get(end) else {
                return (chars.len(), None);
            };
            let params: String = chars[2..end].iter().collect();
            let consumed = end + 1;
            (consumed, csi_key(&params, final_char))
        }
        // ESC + a letter/digit is Alt+key; ESC ESC and anything else is a bare Escape.
        c if c.is_ascii_alphanumeric() => (2, Some(format!("alt+{}", c.to_ascii_lowercase()))),
        '\x7f' => (2, Some("alt+backspace".to_string())),
        '\r' => (2, Some("alt+enter".to_string())),
        _ => (1, Some("esc".to_string())),
    }
}

fn arrow_key(final_char: char) -> &'static str {
    match final_char {
        'A' => "up",
        'B' => "down",
        'C' => "right",
        _ => "left",
    }
}

fn csi_key(params: &str, final_char: char) -> Option<String> {
    match final_char {
        'A'..='D' => {
            let arrow = arrow_key(final_char);
            // `1;<mod>` carries a modifier: 2 shift, 3 alt, 5 ctrl.
            match params.split_once(';').map(|(_, modifier)| modifier) {
                None => Some(arrow.to_string()),
                Some("3") => Some(format!("alt+{arrow}")),
                Some("5") => Some(format!("ctrl+{arrow}")),
                Some(_) => None,
            }
        }
        'Z' => Some("shift+tab".to_string()),
        '~' => match params {
            "15" => Some("f5".into()),
            "17" => Some("f6".into()),
            "18" => Some("f7".into()),
            "19" => Some("f8".into()),
            "20" => Some("f9".into()),
            "21" => Some("f10".into()),
            "23" => Some("f11".into()),
            "24" => Some("f12".into()),
            _ => None,
        },
        _ => None,
    }
}

/// Turns `pane read --source visible --ansi` output into a full-screen repaint: home the cursor,
/// overwrite each row (clearing its tail), clear below. Written over the previous frame rather
/// than after a clear-screen, so a repaint does not flash.
pub(crate) fn render_screen(read_output: &str) -> Bytes {
    let mut out = String::with_capacity(read_output.len() + 64);
    out.push_str("\x1b[?25l\x1b[0m\x1b[H");
    let normalized = read_output.replace("\r\n", "\n");
    let body = normalized.strip_suffix('\n').unwrap_or(&normalized);
    for (index, line) in body.split('\n').enumerate() {
        if index > 0 {
            out.push_str("\r\n");
        }
        out.push_str(line.trim_end_matches('\r'));
        out.push_str("\x1b[0m\x1b[K");
    }
    out.push_str("\x1b[J");
    Bytes::from(out)
}

/// The latest state of a pane feed. `seq` bumps on every repaint so a subscriber that joins late
/// still paints the current screen once.
#[derive(Debug, Clone, Default)]
pub(crate) struct PaneFrame {
    pub(crate) seq: u64,
    pub(crate) screen: Bytes,
    /// Set once the feed is over; the websocket closes with this reason.
    pub(crate) closed: Option<String>,
}

struct SharedFeed {
    frames: watch::Sender<PaneFrame>,
    input_tx: mpsc::UnboundedSender<String>,
    kick: Arc<Notify>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for SharedFeed {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// A browser's handle on a shared pane feed; the poller stops when the last handle drops.
pub(crate) struct PaneFeed {
    feed: Arc<SharedFeed>,
}

impl PaneFeed {
    pub(crate) fn subscribe(&self) -> watch::Receiver<PaneFrame> {
        self.feed.frames.subscribe()
    }

    /// Queues raw terminal input (what xterm emitted) for the pane.
    pub(crate) fn send_input(&self, data: String) {
        let _ = self.feed.input_tx.send(data);
        self.feed.kick.notify_one();
    }
}

struct CachedSnapshot {
    fetched_at: Instant,
    snapshot: SessionSnapshot,
}

/// The configured machine remotes plus the state they share.
pub(crate) struct MachineRemotes {
    machines: Vec<RemoteMachine>,
    runner: Arc<dyn MachineRunner>,
    snapshots: HashMap<String, Arc<tokio::sync::Mutex<Option<CachedSnapshot>>>>,
    feeds: Mutex<HashMap<(String, String), Weak<SharedFeed>>>,
}

impl MachineRemotes {
    pub(crate) fn new(machines: Vec<RemoteMachine>, runner: Arc<dyn MachineRunner>) -> Self {
        let snapshots = machines
            .iter()
            .map(|machine| (machine.id.clone(), Arc::new(tokio::sync::Mutex::new(None))))
            .collect();
        Self {
            machines,
            runner,
            snapshots,
            feeds: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn machines(&self) -> &[RemoteMachine] {
        &self.machines
    }

    pub(crate) fn find(&self, id: &str) -> Option<&RemoteMachine> {
        self.machines.iter().find(|machine| machine.id == id)
    }

    /// The machine's session snapshot, reused for `SNAPSHOT_TTL`. Concurrent callers queue behind
    /// one fetch instead of each opening an SSH connection.
    pub(crate) async fn snapshot(
        &self,
        machine: &RemoteMachine,
    ) -> Result<SessionSnapshot, MachineError> {
        let slot = self
            .snapshots
            .get(&machine.id)
            .cloned()
            .ok_or_else(|| MachineError::plain("unknown machine"))?;
        let mut cached = slot.lock().await;
        if let Some(entry) = cached.as_ref() {
            if entry.fetched_at.elapsed() < SNAPSHOT_TTL {
                return Ok(entry.snapshot.clone());
            }
        }
        let snapshot = self.fetch_snapshot(&machine.label).await?;
        *cached = Some(CachedSnapshot {
            fetched_at: Instant::now(),
            snapshot: snapshot.clone(),
        });
        Ok(snapshot)
    }

    async fn fetch_snapshot(&self, label: &str) -> Result<SessionSnapshot, MachineError> {
        let output = run_blocking(&self.runner, label, &["api", "snapshot"]).await?;
        parse_snapshot_output(&output)
    }

    /// Opens (or joins) the shared feed for `terminal_id` on `machine`.
    pub(crate) async fn open_pane(
        &self,
        machine: &RemoteMachine,
        terminal_id: &str,
    ) -> Result<PaneFeed, MachineError> {
        let key = (machine.id.clone(), terminal_id.to_string());
        if let Some(feed) = self.live_feed(&key) {
            return Ok(PaneFeed { feed });
        }
        // The snapshot cache may predate a pane; ask herdr directly before giving up.
        let pane_id = match pane_id_for_terminal(&self.snapshot(machine).await?, terminal_id) {
            Some(pane_id) => pane_id,
            None => pane_id_for_terminal(&self.fetch_snapshot(&machine.label).await?, terminal_id)
                .ok_or_else(|| MachineError::plain(format!("terminal {terminal_id} not found")))?,
        };
        let mut feeds = self.feeds.lock().expect("machine feed lock poisoned");
        if let Some(feed) = feeds.get(&key).and_then(Weak::upgrade) {
            return Ok(PaneFeed { feed });
        }
        let feed = spawn_feed(
            self.runner.clone(),
            machine.label.clone(),
            terminal_id.to_string(),
            pane_id,
        );
        feeds.insert(key, Arc::downgrade(&feed));
        feeds.retain(|_, feed| feed.strong_count() > 0);
        Ok(PaneFeed { feed })
    }

    fn live_feed(&self, key: &(String, String)) -> Option<Arc<SharedFeed>> {
        self.feeds
            .lock()
            .expect("machine feed lock poisoned")
            .get(key)
            .and_then(Weak::upgrade)
    }
}

async fn run_blocking(
    runner: &Arc<dyn MachineRunner>,
    label: &str,
    args: &[&str],
) -> Result<String, MachineError> {
    let runner = runner.clone();
    let label = label.to_string();
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    tokio::task::spawn_blocking(move || {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        runner.run(&label, &args)
    })
    .await
    .map_err(|err| MachineError::plain(err.to_string()))?
}

fn spawn_feed(
    runner: Arc<dyn MachineRunner>,
    label: String,
    terminal_id: String,
    pane_id: String,
) -> Arc<SharedFeed> {
    let (frames, _) = watch::channel(PaneFrame::default());
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<String>();
    let kick = Arc::new(Notify::new());
    let pane_id = Arc::new(Mutex::new(pane_id));

    let poller = {
        let runner = runner.clone();
        let label = label.clone();
        let frames = frames.clone();
        let kick = kick.clone();
        let pane_id = pane_id.clone();
        tokio::spawn(async move {
            let mut last_read: Option<String> = None;
            let mut seq = 0u64;
            let mut failures = 0u32;
            let mut active_until = Instant::now();
            loop {
                let current_pane = pane_id.lock().expect("pane id lock poisoned").clone();
                let read = run_blocking(
                    &runner,
                    &label,
                    &[
                        "pane",
                        "read",
                        &current_pane,
                        "--source",
                        "visible",
                        "--ansi",
                    ],
                )
                .await;
                match read {
                    Ok(text) => {
                        failures = 0;
                        if last_read.as_deref() != Some(text.as_str()) {
                            seq += 1;
                            frames.send_replace(PaneFrame {
                                seq,
                                screen: render_screen(&text),
                                closed: None,
                            });
                            last_read = Some(text);
                        }
                    }
                    Err(err) if err.is_pane_gone() => {
                        // Pane ids can be renumbered; the terminal id is the stable handle.
                        let moved = match run_blocking(&runner, &label, &["api", "snapshot"]).await
                        {
                            Ok(output) => parse_snapshot_output(&output)
                                .ok()
                                .and_then(|snapshot| pane_id_for_terminal(&snapshot, &terminal_id)),
                            Err(_) => None,
                        };
                        match moved {
                            Some(moved) if moved != current_pane => {
                                *pane_id.lock().expect("pane id lock poisoned") = moved;
                                continue;
                            }
                            _ => {
                                seq += 1;
                                frames.send_replace(PaneFrame {
                                    seq,
                                    screen: Bytes::new(),
                                    closed: Some(format!(
                                        "terminal attach failed: terminal {terminal_id} is gone"
                                    )),
                                });
                                return;
                            }
                        }
                    }
                    Err(err) => {
                        failures += 1;
                        debug!(machine = %label, error = %err, failures, "machine pane read failed");
                        if failures >= MAX_POLL_FAILURES {
                            seq += 1;
                            frames.send_replace(PaneFrame {
                                seq,
                                screen: Bytes::new(),
                                closed: Some(format!("machine {label} unreachable: {err}")),
                            });
                            return;
                        }
                    }
                }
                let interval = if Instant::now() < active_until {
                    POLL_ACTIVE
                } else {
                    POLL_IDLE
                };
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {}
                    _ = kick.notified() => {
                        active_until = Instant::now() + ACTIVE_WINDOW;
                    }
                }
            }
        })
    };

    let sender = {
        let kick = kick.clone();
        tokio::spawn(async move {
            while let Some(first) = input_rx.recv().await {
                // Everything already queued goes out as one ordered batch.
                let mut data = first;
                while let Ok(more) = input_rx.try_recv() {
                    data.push_str(&more);
                }
                let current_pane = pane_id.lock().expect("pane id lock poisoned").clone();
                for op in input_ops(&data) {
                    let result = match &op {
                        InputOp::Text(text) => {
                            run_blocking(
                                &runner,
                                &label,
                                &["pane", "send-text", &current_pane, text],
                            )
                            .await
                        }
                        InputOp::Keys(keys) => {
                            let mut args = vec!["pane", "send-keys", current_pane.as_str()];
                            args.extend(keys.iter().map(String::as_str));
                            run_blocking(&runner, &label, &args).await
                        }
                    };
                    if let Err(err) = result {
                        warn!(machine = %label, error = %err, "failed to send input to machine pane");
                    }
                }
                kick.notify_one();
            }
        })
    };

    Arc::new(SharedFeed {
        frames,
        input_tx,
        kick,
        tasks: vec![poller, sender],
    })
}

/// A trimmed real `herdr --machine <label> api snapshot` (herdr 0.9.5, protocol 22).
#[cfg(test)]
pub(crate) const SNAPSHOT_FIXTURE: &str = r#"{"id":"cli:api:snapshot","result":{"snapshot":{"agents":[{"agent":"claude","agent_status":"done","completion_seq":55,"cwd":"/Users/guest/work","focused":true,"foreground_cwd":"/Users/guest/work","pane_id":"w1:p1","revision":4,"state_change_seq":55,"tab_id":"w1:t1","terminal_id":"term_aaa","terminal_title":"✳ Review the draft","terminal_title_stripped":"Review the draft","workspace_id":"w1"}],"focused_pane_id":"w1:p1","focused_tab_id":"w1:t1","focused_workspace_id":"w1","layouts":[{"area":{"height":50,"width":135,"x":0,"y":0},"focused_pane_id":"w1:p1","panes":[{"focused":true,"pane_id":"w1:p1","rect":{"height":50,"width":68,"x":0,"y":0}},{"focused":false,"pane_id":"w1:p3","rect":{"height":50,"width":67,"x":68,"y":0}}],"splits":[{"direction":"right","id":"split_0_root","ratio":0.5,"rect":{"height":50,"width":135,"x":0,"y":0}}],"tab_id":"w1:t1","workspace_id":"w1","zoomed":false}],"panes":[{"agent":"claude","agent_status":"done","cwd":"/Users/guest/work","focused":true,"foreground_cwd":"/Users/guest/work","pane_id":"w1:p1","revision":4,"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":48},"tab_id":"w1:t1","terminal_id":"term_aaa","terminal_title":"✳ Review the draft","terminal_title_stripped":"Review the draft","workspace_id":"w1"},{"agent_status":"unknown","cwd":"/Users/guest/work","focused":false,"foreground_cwd":"/Users/guest/work","pane_id":"w1:p3","revision":0,"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":48},"tab_id":"w1:t1","terminal_id":"term_bbb","workspace_id":"w1"}],"protocol":22,"tabs":[{"agent_status":"done","focused":true,"label":"1","number":1,"pane_count":2,"tab_id":"w1:t1","workspace_id":"w1"}],"version":"0.9.5","workspaces":[{"active_tab_id":"w1:t1","agent_status":"done","focused":true,"label":"work","number":1,"pane_count":2,"tab_count":1,"workspace_id":"w1"}]},"type":"session_snapshot"}}"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(names: &[&str]) -> InputOp {
        InputOp::Keys(names.iter().map(|name| name.to_string()).collect())
    }

    #[test]
    fn snapshot_output_maps_workspaces_tabs_panes_and_agent_status() {
        let snapshot = parse_snapshot_output(SNAPSHOT_FIXTURE).unwrap();
        assert_eq!(snapshot.workspaces.len(), 1);
        assert_eq!(snapshot.workspaces[0].label, "work");
        assert_eq!(snapshot.tabs.len(), 1);
        assert_eq!(snapshot.tabs[0].tab_id, "w1:t1");
        assert_eq!(snapshot.panes.len(), 2);
        assert_eq!(snapshot.panes[0].agent.as_deref(), Some("claude"));
        assert_eq!(
            serde_json::to_value(snapshot.panes[0].agent_status).unwrap(),
            "done"
        );
        assert_eq!(snapshot.layouts.len(), 1);
        assert_eq!(snapshot.focused_pane_id.as_deref(), Some("w1:p1"));
    }

    #[test]
    fn snapshot_output_rejects_errors_and_other_results() {
        let err = parse_snapshot_output(
            r#"{"id":"cli:api:snapshot","error":{"code":"x","message":"nope"}}"#,
        )
        .unwrap_err();
        assert!(err.message.contains("unexpected herdr snapshot response"));
        assert!(parse_snapshot_output("not json").is_err());
        assert!(parse_snapshot_output(
            r#"{"id":"cli","result":{"type":"pong","version":"0.9.5","protocol":22}}"#
        )
        .is_err());
    }

    #[test]
    fn pane_id_resolves_from_terminal_id() {
        let snapshot = parse_snapshot_output(SNAPSHOT_FIXTURE).unwrap();
        assert_eq!(
            pane_id_for_terminal(&snapshot, "term_bbb").as_deref(),
            Some("w1:p3")
        );
        assert_eq!(pane_id_for_terminal(&snapshot, "term_zzz"), None);
    }

    #[test]
    fn cli_failure_parses_herdr_api_errors_and_plain_text() {
        let api = parse_cli_failure(
            "",
            "{\"error\":{\"code\":\"pane_not_found\",\"message\":\"pane w1:p9 not found\"},\"id\":\"cli:pane:read\"}\n",
        );
        assert!(api.is_pane_gone());
        assert_eq!(api.message, "pane w1:p9 not found");

        let plain = parse_cli_failure("", "error: unknown machine 'x'; use `herdr machine list`\n");
        assert_eq!(plain.code, None);
        assert!(plain.message.starts_with("error: unknown machine"));
        assert_eq!(
            parse_cli_failure("", "").message,
            "herdr exited with an error"
        );
    }

    #[test]
    fn machine_label_validation() {
        assert_eq!(normalize_machine_label("  melanie ").unwrap(), "melanie");
        assert!(normalize_machine_label("").is_err());
        assert!(normalize_machine_label("   ").is_err());
        assert!(normalize_machine_label("-melanie").is_err());
        assert!(normalize_machine_label("mel\nanie").is_err());
        assert!(normalize_machine_label(&"x".repeat(65)).is_err());
        assert_eq!(
            normalize_machine_label("Melanie's Laptop").unwrap(),
            "Melanie's Laptop"
        );
    }

    #[test]
    fn build_remote_machines_slugs_dedups_and_avoids_taken_ids() {
        let labels = vec![
            "Melanie".to_string(),
            "Melanie".to_string(),
            "mini 3".to_string(),
            "mini-3".to_string(),
            "!!!".to_string(),
        ];
        let taken: HashSet<String> = ["mini-3".to_string()].into();
        let machines = build_remote_machines(&labels, &taken);
        let ids: Vec<&str> = machines.iter().map(|machine| machine.id.as_str()).collect();
        assert_eq!(ids, vec!["melanie", "mini-3-2", "mini-3-3", "machine"]);
        assert_eq!(machines[0].label, "Melanie");
        assert_eq!(machines[0].display_url(), "herdr-machine://melanie");
    }

    #[test]
    fn capabilities_advertise_no_bridge_features() {
        let caps = capabilities_json();
        assert_eq!(caps["commands"], serde_json::json!([]));
        assert!(caps.get("agent_pins").is_none());
        assert!(caps.get("notes").is_none());
    }

    #[test]
    fn input_text_and_enter_become_send_text_then_key() {
        assert_eq!(
            input_ops("hello world\r"),
            vec![InputOp::Text("hello world".into()), keys(&["enter"])]
        );
        assert_eq!(
            input_ops("-x --match"),
            vec![InputOp::Text("-x --match".into())]
        );
        assert!(input_ops("").is_empty());
    }

    #[test]
    fn input_control_bytes_become_named_keys_and_merge() {
        assert_eq!(
            input_ops("\x03\x04\x7f\t"),
            vec![keys(&["ctrl+c", "ctrl+d", "backspace", "tab"])]
        );
        assert_eq!(
            input_ops("ls\x03"),
            vec![InputOp::Text("ls".into()), keys(&["ctrl+c"])]
        );
        assert_eq!(input_ops("\x00\x1c"), Vec::<InputOp>::new());
    }

    #[test]
    fn input_escape_sequences_map_to_keys() {
        assert_eq!(
            input_ops("\x1b[A\x1b[B\x1b[C\x1b[D"),
            vec![keys(&["up", "down", "right", "left"])]
        );
        assert_eq!(input_ops("\x1bOA\x1bOP"), vec![keys(&["up", "f1"])]);
        assert_eq!(input_ops("\x1b[Z"), vec![keys(&["shift+tab"])]);
        assert_eq!(input_ops("\x1b"), vec![keys(&["esc"])]);
        assert_eq!(input_ops("\x1b[15~\x1b[24~"), vec![keys(&["f5", "f12"])]);
        assert_eq!(input_ops("\x1b[1;5D"), vec![keys(&["ctrl+left"])]);
        assert_eq!(input_ops("\x1bb"), vec![keys(&["alt+b"])]);
        assert_eq!(
            input_ops("a\x1b[Ab"),
            vec![
                InputOp::Text("a".into()),
                keys(&["up"]),
                InputOp::Text("b".into())
            ]
        );
    }

    #[test]
    fn input_drops_keys_herdr_cannot_send() {
        // Home, End, PageUp, PageDown, Delete, Insert: not in herdr's send-keys vocabulary.
        assert_eq!(
            input_ops("\x1b[H\x1b[F\x1b[5~\x1b[6~\x1b[3~\x1b[2~"),
            Vec::<InputOp>::new()
        );
        assert_eq!(input_ops("\x1b[Hx"), vec![InputOp::Text("x".into())]);
    }

    #[test]
    fn input_bracketed_paste_stays_literal_text() {
        assert_eq!(
            input_ops("\x1b[200~line one\r\nline two\rthree\x1b[201~\r"),
            vec![
                InputOp::Text("line one\nline two\nthree".into()),
                keys(&["enter"])
            ]
        );
    }

    #[test]
    fn render_screen_repaints_in_place() {
        let frame = render_screen("\r\nhello\r\nworld\r\n");
        let text = String::from_utf8(frame.to_vec()).unwrap();
        assert!(text.starts_with("\x1b[?25l\x1b[0m\x1b[H"));
        assert!(text.contains("\x1b[0m\x1b[K\r\nhello\x1b[0m\x1b[K\r\nworld\x1b[0m\x1b[K"));
        assert!(text.ends_with("\x1b[J"));
        assert!(!text.contains("\x1b[2J"));
    }

    struct FakeRunner {
        calls: Mutex<Vec<Vec<String>>>,
        read: Mutex<Result<String, MachineError>>,
    }

    impl FakeRunner {
        fn new(read: Result<String, MachineError>) -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                read: Mutex::new(read),
            })
        }
    }

    impl MachineRunner for FakeRunner {
        fn run(&self, machine: &str, args: &[&str]) -> Result<String, MachineError> {
            let mut call = vec![machine.to_string()];
            call.extend(args.iter().map(|arg| arg.to_string()));
            self.calls.lock().unwrap().push(call);
            match args {
                ["api", "snapshot"] => Ok(SNAPSHOT_FIXTURE.to_string()),
                ["pane", "read", ..] => self.read.lock().unwrap().clone(),
                _ => Ok(String::new()),
            }
        }
    }

    fn machine() -> RemoteMachine {
        RemoteMachine {
            id: "melanie".into(),
            label: "melanie".into(),
        }
    }

    #[tokio::test]
    async fn snapshot_is_cached_between_close_requests() {
        let runner = FakeRunner::new(Ok(String::new()));
        let remotes = MachineRemotes::new(vec![machine()], runner.clone());
        let first = remotes.snapshot(&machine()).await.unwrap();
        let second = remotes.snapshot(&machine()).await.unwrap();
        assert_eq!(first, second);
        let snapshot_calls = runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call[1] == "api")
            .count();
        assert_eq!(snapshot_calls, 1);
    }

    #[tokio::test]
    async fn pane_feed_paints_screen_and_sends_input_through_machine_api() {
        let runner = FakeRunner::new(Ok("hi\r\n".to_string()));
        let remotes = MachineRemotes::new(vec![machine()], runner.clone());
        let feed = remotes.open_pane(&machine(), "term_bbb").await.unwrap();
        let mut frames = feed.subscribe();
        tokio::time::timeout(
            Duration::from_secs(5),
            frames.wait_for(|frame| frame.seq > 0),
        )
        .await
        .expect("screen painted")
        .unwrap();
        let screen = String::from_utf8(frames.borrow().screen.to_vec()).unwrap();
        assert!(screen.contains("hi"));

        feed.send_input("ls\r".to_string());
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let calls = runner.calls.lock().unwrap().clone();
                if calls
                    .iter()
                    .any(|call| call[1..] == ["pane", "send-keys", "w1:p3", "enter"])
                {
                    return calls;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("keys sent");
        let calls = runner.calls.lock().unwrap().clone();
        assert!(calls
            .iter()
            .any(|call| call[..] == ["melanie", "pane", "send-text", "w1:p3", "ls"]));
        assert!(calls.iter().all(|call| call[0] == "melanie"));
    }

    #[tokio::test]
    async fn feed_is_shared_per_terminal_and_unknown_terminal_is_rejected() {
        let runner = FakeRunner::new(Ok("x".to_string()));
        let remotes = MachineRemotes::new(vec![machine()], runner);
        let a = remotes.open_pane(&machine(), "term_aaa").await.unwrap();
        let b = remotes.open_pane(&machine(), "term_aaa").await.unwrap();
        assert!(Arc::ptr_eq(&a.feed, &b.feed));
        let err = remotes
            .open_pane(&machine(), "term_nope")
            .await
            .err()
            .unwrap();
        assert!(err.message.contains("not found"));
    }

    #[tokio::test]
    async fn feed_closes_when_the_pane_is_gone() {
        let gone = MachineError {
            code: Some("pane_not_found".into()),
            message: "pane w1:p3 not found".into(),
        };
        // The snapshot still lists the pane under the same id, so it is truly gone.
        let runner = FakeRunner::new(Err(gone));
        let remotes = MachineRemotes::new(vec![machine()], runner);
        let feed = remotes.open_pane(&machine(), "term_bbb").await.unwrap();
        let mut frames = feed.subscribe();
        let frame = tokio::time::timeout(
            Duration::from_secs(5),
            frames.wait_for(|frame| frame.closed.is_some()),
        )
        .await
        .expect("closed")
        .unwrap()
        .clone();
        assert!(frame.closed.unwrap().starts_with("terminal attach failed"));
    }
}
