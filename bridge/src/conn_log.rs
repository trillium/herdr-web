//! Per-connection device logging for the herdr-web bridge.
//!
//! Additive logging only: one line per inbound HTTP connection (including
//! websocket upgrades) in the existing bridge file log (`herdr-web.log`), so
//! future "did my phone reach it" questions are answerable from the log.
//!
//! Privacy: local-only log, no payload bodies, no query strings, no tokens.
//! The user-agent is truncated to a family/device class. Rate-safety: repeated
//! identical lines are coalesced within a short window so reconnect storms do
//! not flood the log. The existing 5MB rollover behavior is untouched.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request as AxumRequest};
use axum::http::header::USER_AGENT;
use axum::middleware::Next;
use axum::response::Response;
use std::net::SocketAddr;

pub(crate) const CONN_LOG_TARGET: &str = "herdr_web_bridge::conn";
const COALESCE_WINDOW: Duration = Duration::from_secs(10);
const MAX_PATH_BYTES: usize = 256;
const MAX_PEER_LABEL_BYTES: usize = 256;
const HOSTNAME_CACHE_TTL: Duration = Duration::from_secs(600);

/// Axum middleware: logs one coalesced line per request after serving it.
/// Outermost layer so the logged status is the final one. Never alters the
/// request or response.
pub(crate) async fn log_connection_middleware(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: AxumRequest,
    next: Next,
) -> Response {
    let path = sanitize_path(request.uri().path());
    let family = ua_family(
        request
            .headers()
            .get(USER_AGENT)
            .and_then(|value| value.to_str().ok()),
    );
    let response = next.run(request).await;
    log_connection(addr.ip(), &path, response.status().as_u16(), family);
    response
}

/// Record one connection. Emits to the file log via tracing unless an
/// identical line was recently emitted (coalesced for storm safety).
pub(crate) fn log_connection(peer: IpAddr, path: &str, status: u16, ua_family: &'static str) {
    let peer_label = peer_label(peer);
    let line = format_conn_line(&peer_label, path, status, ua_family);
    let emit = gate()
        .lock()
        .map(|mut gate| gate.should_emit(line))
        .unwrap_or(GateDecision::Suppress);
    if let GateDecision::Emit(line) = emit {
        emit_line(line);
    }
}

/// One log line. `peer` is a tailnet hostname or IP, `path` is already
/// sanitized (no query string), `ua_family` is a device class, never raw UA.
pub(crate) fn format_conn_line(peer: &str, path: &str, status: u16, ua_family: &str) -> String {
    let now = chrono_timestamp();
    format!("conn time={now} peer={peer} path={path} status={status} ua={ua_family}")
}

fn chrono_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// Truncate a user-agent to a family/device class. Never returns raw UA text.
pub(crate) fn ua_family(raw: Option<&str>) -> &'static str {
    let Some(raw) = raw else {
        return "unknown";
    };
    if raw.is_empty() {
        return "unknown";
    }
    let lower = raw.to_lowercase();
    if lower.contains("iphone") {
        return "ios-mobile";
    }
    if lower.contains("ipad") {
        return "ios-tablet";
    }
    if lower.contains("android") {
        return "android-mobile";
    }
    if lower.contains("curl") {
        return "curl";
    }
    if lower.contains("wget") {
        return "wget";
    }
    if lower.contains("mobile") {
        return "mobile";
    }
    if lower.contains("macintosh") || lower.contains("mac os") {
        return "mac-desktop";
    }
    if lower.contains("windows") {
        return "windows-desktop";
    }
    if lower.contains("linux") {
        return "linux-desktop";
    }
    "desktop-browser"
}

/// Strip query string and fragment, truncate to a byte boundary. Paths never
/// carry tokens in this bridge, and query strings are dropped regardless.
pub(crate) fn sanitize_path(path: &str) -> String {
    let bare = path.split(['?', '#']).next().unwrap_or("");
    let bare = if bare.is_empty() { "/" } else { bare };
    truncate_to_bytes(bare, MAX_PATH_BYTES)
}

fn truncate_to_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

/// Resolve a caller label: cached tailnet hostname, else the peer IP.
/// Resolution is best-effort in a background task and never blocks serving:
/// a cache miss logs the IP now and warms the cache for the next line.
fn peer_label(peer: IpAddr) -> String {
    if let Some(cached) = hostname_cache().lock().ok().and_then(|cache| {
        cache
            .get(&peer)
            .filter(|(_, at)| at.elapsed() < HOSTNAME_CACHE_TTL)
            .map(|(name, _)| name.clone())
    }) {
        return truncate_to_bytes(&cached, MAX_PEER_LABEL_BYTES);
    }
    if hostname_cache()
        .lock()
        .map(|cache| cache.contains_key(&peer))
        .unwrap_or(true)
    {
        return peer.to_string();
    }
    mark_pending_and_resolve(peer);
    peer.to_string()
}

fn mark_pending_and_resolve(peer: IpAddr) {
    if !pending_lookups()
        .lock()
        .map(|mut pending| pending.insert(peer))
        .unwrap_or(false)
    {
        return;
    }
    tokio::spawn(async move {
        let name = tokio::task::spawn_blocking(move || reverse_lookup(peer))
            .await
            .ok()
            .flatten();
        if let Some(name) = name {
            if let Ok(mut cache) = hostname_cache().lock() {
                cache.insert(peer, (name, Instant::now()));
            }
        } else if let Ok(mut cache) = hostname_cache().lock() {
            // Negative cache briefly so storms of unknown peers don't spam lookups.
            cache.insert(peer, (peer.to_string(), Instant::now()));
        }
        if let Ok(mut pending) = pending_lookups().lock() {
            pending.remove(&peer);
        }
    });
}

/// Reverse-DNS a peer IP via getnameinfo. Returns None on any failure or when
/// the resolver just echoes the numeric address back.
fn reverse_lookup(peer: IpAddr) -> Option<String> {
    use std::ffi::CStr;
    use std::mem;

    let mut host = [0 as libc::c_char; 1025];
    let rc = match peer {
        IpAddr::V4(v4) => {
            let mut addr: libc::sockaddr_in = unsafe { mem::zeroed() };
            addr.sin_family = libc::AF_INET as libc::sa_family_t;
            addr.sin_addr = libc::in_addr {
                s_addr: u32::from_ne_bytes(v4.octets()),
            };
            #[cfg(target_vendor = "apple")]
            {
                addr.sin_len = mem::size_of::<libc::sockaddr_in>() as u8;
            }
            unsafe {
                libc::getnameinfo(
                    &addr as *const libc::sockaddr_in as *const libc::sockaddr,
                    mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
                    host.as_mut_ptr(),
                    host.len() as libc::socklen_t,
                    std::ptr::null_mut(),
                    0,
                    libc::NI_NAMEREQD,
                )
            }
        }
        IpAddr::V6(v6) => {
            let mut addr: libc::sockaddr_in6 = unsafe { mem::zeroed() };
            addr.sin6_family = libc::AF_INET6 as libc::sa_family_t;
            addr.sin6_addr = libc::in6_addr {
                s6_addr: v6.octets(),
            };
            #[cfg(target_vendor = "apple")]
            {
                addr.sin6_len = mem::size_of::<libc::sockaddr_in6>() as u8;
            }
            unsafe {
                libc::getnameinfo(
                    &addr as *const libc::sockaddr_in6 as *const libc::sockaddr,
                    mem::size_of::<libc::sockaddr_in6>() as libc::socklen_t,
                    host.as_mut_ptr(),
                    host.len() as libc::socklen_t,
                    std::ptr::null_mut(),
                    0,
                    libc::NI_NAMEREQD,
                )
            }
        }
    };
    if rc != 0 {
        return None;
    }
    let name = unsafe { CStr::from_ptr(host.as_ptr()).to_string_lossy().into_owned() };
    if name.is_empty() || name == peer.to_string() {
        return None;
    }
    Some(name)
}

fn emit_line(line: String) {
    #[cfg(test)]
    {
        test_sink().lock().map(|mut sink| sink.push(line)).ok();
    }
    #[cfg(not(test))]
    {
        tracing::info!(target: CONN_LOG_TARGET, "{line}");
    }
}

fn gate() -> &'static Mutex<ConnLogGate> {
    static GATE: OnceLock<Mutex<ConnLogGate>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(ConnLogGate::new(COALESCE_WINDOW)))
}

fn hostname_cache() -> &'static Mutex<HashMap<IpAddr, (String, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<IpAddr, (String, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_lookups() -> &'static Mutex<HashSet<IpAddr>> {
    static PENDING: OnceLock<Mutex<HashSet<IpAddr>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashSet::new()))
}

enum GateDecision {
    Emit(String),
    Suppress,
}

/// Coalesces repeated identical lines within a window. The first line emits
/// immediately; repeats inside the window are suppressed and counted, and the
/// count rides along on the next emitted line.
struct ConnLogGate {
    window: Duration,
    last_line: Option<String>,
    window_start: Option<Instant>,
    suppressed: u64,
}

impl ConnLogGate {
    fn new(window: Duration) -> Self {
        Self {
            window,
            last_line: None,
            window_start: None,
            suppressed: 0,
        }
    }

    fn should_emit(&mut self, line: String) -> GateDecision {
        let now = Instant::now();
        let same_as_last = self.last_line.as_deref() == Some(line.as_str());
        let in_window = self
            .window_start
            .map(|start| now.duration_since(start) < self.window)
            .unwrap_or(false);
        if same_as_last && in_window {
            self.suppressed += 1;
            return GateDecision::Suppress;
        }
        let out = if self.suppressed > 0 {
            format!("{line} (x{} similar suppressed)", self.suppressed)
        } else {
            line
        };
        self.last_line = Some(out.clone());
        // When the suppressed count rode along, reset it; the fresh line
        // starts a new window only if it differs, otherwise extend.
        self.suppressed = 0;
        self.window_start = Some(now);
        GateDecision::Emit(out)
    }
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    if let Ok(mut gate) = gate().lock() {
        *gate = ConnLogGate::new(COALESCE_WINDOW);
    }
    if let Ok(mut cache) = hostname_cache().lock() {
        cache.clear();
    }
    if let Ok(mut pending) = pending_lookups().lock() {
        pending.clear();
    }
    if let Ok(mut sink) = test_sink().lock() {
        sink.clear();
    }
}

#[cfg(test)]
fn test_sink() -> &'static Mutex<Vec<String>> {
    static SINK: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    SINK.get_or_init(|| Mutex::new(Vec::new()))
}

#[cfg(test)]
fn test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
#[cfg(test)]
pub(crate) fn take_test_lines() -> Vec<String> {
    test_sink()
        .lock()
        .map(|mut sink| std::mem::take(&mut *sink))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conn_log_target_is_stable_for_log_queries() {
        assert_eq!(CONN_LOG_TARGET, "herdr_web_bridge::conn");
    }

    #[test]
    fn ua_family_classifies_common_devices() {
        assert_eq!(
            ua_family(Some(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"
            )),
            "ios-mobile"
        );
        assert_eq!(
            ua_family(Some("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")),
            "ios-tablet"
        );
        assert_eq!(
            ua_family(Some(
                "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit Mobile"
            )),
            "android-mobile"
        );
        assert_eq!(ua_family(Some("curl/8.4.0")), "curl");
        assert_eq!(ua_family(Some("Wget/1.21")), "wget");
        assert_eq!(
            ua_family(Some("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")),
            "mac-desktop"
        );
        assert_eq!(
            ua_family(Some("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")),
            "windows-desktop"
        );
        assert_eq!(
            ua_family(Some("Mozilla/5.0 (X11; Linux x86_64)")),
            "linux-desktop"
        );
        assert_eq!(ua_family(None), "unknown");
        assert_eq!(ua_family(Some("")), "unknown");
    }

    #[test]
    fn sanitize_path_strips_query_and_fragment() {
        assert_eq!(
            sanitize_path("/api/version?token=secret&x=1"),
            "/api/version"
        );
        assert_eq!(sanitize_path("/ws/terminal#frag"), "/ws/terminal");
        assert_eq!(sanitize_path(""), "/");
        assert_eq!(sanitize_path("/api/version"), "/api/version");
    }

    #[test]
    fn sanitize_path_truncates_long_paths() {
        let long = format!("/{}", "a".repeat(500));
        let out = sanitize_path(&long);
        assert!(out.len() <= MAX_PATH_BYTES);
        assert!(out.starts_with("/aaa"));
    }

    #[test]
    fn formatted_line_carries_expected_fields_and_no_private_data() {
        let raw_ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
        let line = format_conn_line(
            "phone.tailnet.ts.net",
            "/api/version",
            200,
            ua_family(Some(raw_ua)),
        );
        assert!(line.contains("peer=phone.tailnet.ts.net"));
        assert!(line.contains("path=/api/version"));
        assert!(line.contains("status=200"));
        assert!(line.contains("ua=ios-mobile"));
        assert!(!line.contains("AppleWebKit"));
    }

    #[test]
    fn query_tokens_never_reach_the_line() {
        let path = sanitize_path("/api/command?token=sekret-abc123");
        let line = format_conn_line("100.64.0.5", &path, 200, ua_family(Some("curl/8.4.0")));
        assert!(!line.contains("sekret-abc123"));
        assert!(!line.contains('?'));
        assert!(!line.contains("token"));
    }

    #[test]
    fn gate_emits_first_line_and_coalesces_repeats() {
        let mut gate = ConnLogGate::new(Duration::from_secs(60));
        let line = "conn peer=a path=/ status=200 ua=curl".to_string();
        assert!(matches!(
            gate.should_emit(line.clone()),
            GateDecision::Emit(_)
        ));
        assert!(matches!(
            gate.should_emit(line.clone()),
            GateDecision::Suppress
        ));
        assert!(matches!(
            gate.should_emit(line.clone()),
            GateDecision::Suppress
        ));
        match gate.should_emit("conn peer=b path=/ status=200 ua=curl".to_string()) {
            GateDecision::Emit(out) => assert!(out.contains("x2 similar suppressed")),
            GateDecision::Suppress => panic!("different line must emit"),
        }
    }

    #[test]
    fn gate_reopens_after_window() {
        let mut gate = ConnLogGate::new(Duration::from_millis(1));
        let line = "conn peer=a path=/ status=200 ua=curl".to_string();
        assert!(matches!(
            gate.should_emit(line.clone()),
            GateDecision::Emit(_)
        ));
        std::thread::sleep(Duration::from_millis(5));
        assert!(matches!(gate.should_emit(line), GateDecision::Emit(_)));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn middleware_logs_one_line_per_request_without_raw_ua_or_query() {
        use axum::extract::ConnectInfo;
        use axum::routing::get;
        use tower::ServiceExt;

        let _guard = test_lock().lock().unwrap();
        reset_for_tests();
        let app = axum::Router::new()
            .route("/api/version", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(log_connection_middleware));
        let addr: SocketAddr = "100.64.0.5:1234".parse().unwrap();
        let mut req = axum::http::Request::builder()
            .uri("/api/version?token=sekret-abc123")
            .header(
                "user-agent",
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
            )
            .body(axum::body::Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let response = app.oneshot(req).await.unwrap();
        assert_eq!(response.status(), 200);

        // Background hostname lookup must not race the assertion: cache is
        // empty in tests so the label is the raw IP.
        let lines = take_test_lines();
        assert_eq!(lines.len(), 1, "expected one log line, got {lines:?}");
        assert!(lines[0].contains("peer=100.64.0.5"));
        assert!(lines[0].contains("path=/api/version"));
        assert!(lines[0].contains("status=200"));
        assert!(lines[0].contains("ua=ios-mobile"));
        assert!(!lines[0].contains("sekret-abc123"));
        assert!(!lines[0].contains("iPhone; CPU"));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn middleware_coalesces_reconnect_storms() {
        use axum::extract::ConnectInfo;
        use axum::routing::get;
        use tower::ServiceExt;

        let _guard = test_lock().lock().unwrap();
        reset_for_tests();
        let app = axum::Router::new()
            .route("/ws/terminal", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(log_connection_middleware));
        for _ in 0..5 {
            let addr: SocketAddr = "100.64.0.9:4321".parse().unwrap();
            let mut req = axum::http::Request::builder()
                .uri("/ws/terminal")
                .header("user-agent", "curl/8.4.0")
                .body(axum::body::Body::empty())
                .unwrap();
            req.extensions_mut().insert(ConnectInfo(addr));
            let response = app.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status(), 200);
        }
        let lines = take_test_lines();
        assert_eq!(
            lines.len(),
            1,
            "storm must coalesce to one line, got {lines:?}"
        );
    }
}
