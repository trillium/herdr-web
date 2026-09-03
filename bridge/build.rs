//! Bakes a build stamp (git sha + build time) into the bridge binary so `/api/version` can
//! report which build is running without shelling out to `git` at runtime.
//!
//! Neither value is allowed to fail the build: a source tarball has no `.git`, and a machine
//! without `git` on PATH must still be able to build the bridge. Both fall back to `unknown`.

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src");
    for path in git_stdout(&["rev-parse", "--git-path", "HEAD"])
        .into_iter()
        .chain(
            git_stdout(&["rev-parse", "--symbolic-full-name", "HEAD"])
                .into_iter()
                .filter_map(|head_ref| git_stdout(&["rev-parse", "--git-path", &head_ref])),
        )
    {
        println!("cargo:rerun-if-changed={path}");
    }

    let sha = git_stdout(&["rev-parse", "--short", "HEAD"])
        .map(|sha| {
            if worktree_is_dirty() {
                format!("{sha}-dirty")
            } else {
                sha
            }
        })
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=HERDR_WEB_GIT_SHA={sha}");
    println!("cargo:rustc-env=HERDR_WEB_BUILD_TIME={}", build_time());
}

/// Runs `git` in the crate directory and returns trimmed stdout, or `None` when git is missing,
/// this is not a repository, or the command failed.
fn git_stdout(args: &[&str]) -> Option<String> {
    let dir = std::env::var("CARGO_MANIFEST_DIR").ok()?;
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// `git status --porcelain` prints nothing for a clean tree, so "some output" means dirty.
fn worktree_is_dirty() -> bool {
    git_stdout(&["status", "--porcelain"]).is_some()
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ`, formatted by hand so the build stays
/// dependency-free. Falls back to `unknown` if the clock predates the epoch.
fn build_time() -> String {
    let Ok(elapsed) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return "unknown".to_string();
    };
    format_utc(elapsed.as_secs())
}

fn format_utc(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let secs_of_day = epoch_secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

/// Howard Hinnant's days-from-civil inverse: converts a day count since 1970-01-01 into a
/// proleptic Gregorian (year, month, day).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
