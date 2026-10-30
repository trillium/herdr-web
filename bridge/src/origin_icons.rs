//! Per-origin PWA branding: the manifest, favicon and home-screen icons are recoloured from the
//! request `Host`, so each machine's bridge installs as a visibly different app.
//!
//! Every origin (`mini0:8787`, `macbook:8787`, ...) is its own PWA. The colour for a host comes
//! from an optional JSON map (`--origin-colors PATH`, `{"mini0": "#e06c75"}`), falling back to a
//! deterministic hue derived from the hostname. Anything that cannot be recoloured is served
//! unchanged from the static dir, so the default look survives a missing host or asset.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, HOST, VARY};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

/// Glyph and background colours baked into the stock `herdr-logo.svg` / PNGs.
const STOCK_GLYPH: [u8; 3] = [0x30, 0x34, 0x38];
const STOCK_BACKGROUND: [u8; 3] = [0xd9, 0xda, 0xd8];
/// Glyph colour used on the recoloured icons (the app's own dark surface).
const NEW_GLYPH: [u8; 3] = [0x11, 0x11, 0x1b];

pub const ICON_FILES: [&str; 5] = [
    "herdr-logo-180.png",
    "herdr-logo-192.png",
    "herdr-logo-512.png",
    "herdr-logo-maskable-192.png",
    "herdr-logo-maskable-512.png",
];

pub struct OriginIcons {
    static_dir: PathBuf,
    colors: HashMap<String, [u8; 3]>,
    png_cache: Mutex<HashMap<(String, [u8; 3]), Bytes>>,
}

impl OriginIcons {
    pub fn new(static_dir: PathBuf, colors_path: Option<&Path>) -> Result<Arc<Self>, String> {
        let colors = match colors_path {
            Some(path) => load_color_map(path)?,
            None => HashMap::new(),
        };
        Ok(Arc::new(Self {
            static_dir,
            colors,
            png_cache: Mutex::new(HashMap::new()),
        }))
    }

    fn color_for(&self, host: &str) -> [u8; 3] {
        resolve_color(&self.colors, host)
    }

    pub fn manifest(&self, headers: &HeaderMap) -> Response {
        let stock = std::fs::read(self.static_dir.join("manifest.json")).ok();
        let Some(host) = request_hostname(headers) else {
            return respond_stock(stock, "application/manifest+json");
        };
        let Some(stock) = stock else {
            return StatusCode::NOT_FOUND.into_response();
        };
        match build_manifest(&stock, &host, self.color_for(&host)) {
            Some(body) => respond(body.into(), "application/manifest+json"),
            None => respond_stock(Some(stock), "application/manifest+json"),
        }
    }

    pub fn svg(&self, headers: &HeaderMap) -> Response {
        let stock = std::fs::read(self.static_dir.join("herdr-logo.svg")).ok();
        let Some(host) = request_hostname(headers) else {
            return respond_stock(stock, "image/svg+xml");
        };
        let Some(stock) = stock else {
            return StatusCode::NOT_FOUND.into_response();
        };
        match String::from_utf8(stock.clone()) {
            Ok(text) => respond(
                recolor_svg(&text, self.color_for(&host))
                    .into_bytes()
                    .into(),
                "image/svg+xml",
            ),
            Err(_) => respond_stock(Some(stock), "image/svg+xml"),
        }
    }

    pub fn png(&self, file: &str, headers: &HeaderMap) -> Response {
        let stock = std::fs::read(self.static_dir.join(file)).ok();
        let Some(host) = request_hostname(headers) else {
            return respond_stock(stock, "image/png");
        };
        let Some(stock) = stock else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let color = self.color_for(&host);
        let key = (file.to_string(), color);
        if let Some(hit) = self
            .png_cache
            .lock()
            .ok()
            .and_then(|c| c.get(&key).cloned())
        {
            return respond(hit, "image/png");
        }
        match recolor_png(&stock, color) {
            Some(bytes) => {
                let bytes = Bytes::from(bytes);
                if let Ok(mut cache) = self.png_cache.lock() {
                    cache.insert(key, bytes.clone());
                }
                respond(bytes, "image/png")
            }
            None => respond_stock(Some(stock), "image/png"),
        }
    }
}

fn respond(body: Bytes, content_type: &'static str) -> Response {
    let mut response = (StatusCode::OK, body).into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    // The bytes depend on the Host header; keep shared caches from crossing origins.
    headers.insert(VARY, HeaderValue::from_static("Host"));
    response
}

fn respond_stock(stock: Option<Vec<u8>>, content_type: &'static str) -> Response {
    match stock {
        Some(bytes) => respond(bytes.into(), content_type),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The request's hostname without port, lowercased. `X-Forwarded-Host` is deliberately ignored:
/// the bridge does not trust proxies.
pub fn request_hostname(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(HOST)?.to_str().ok()?.trim();
    let host = if let Some(rest) = raw.strip_prefix('[') {
        rest.split(']').next()?
    } else {
        raw.split(':').next()?
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// First DNS label for names, the whole string for IPs.
fn display_name(host: &str) -> &str {
    if host.parse::<std::net::IpAddr>().is_ok() || host.contains(':') {
        host
    } else {
        host.split('.').next().unwrap_or(host)
    }
}

pub fn resolve_color(map: &HashMap<String, [u8; 3]>, host: &str) -> [u8; 3] {
    if let Some(color) = map.get(host).or_else(|| map.get(display_name(host))) {
        return *color;
    }
    let (r, g, b) = hsl_to_rgb(hash_hue(display_name(host)), 0.62, 0.58);
    [r, g, b]
}

/// FNV-1a over the name, mapped onto the hue circle.
fn hash_hue(name: &str) -> f32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in name.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    (hash % 360) as f32
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match (h / 60.0) as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let to_byte = |v: f32| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    (to_byte(r), to_byte(g), to_byte(b))
}

pub fn parse_hex_color(value: &str) -> Option<[u8; 3]> {
    let hex = value.trim().strip_prefix('#')?;
    if hex.len() != 6 || !hex.is_ascii() {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some([channel(0)?, channel(2)?, channel(4)?])
}

fn hex(color: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", color[0], color[1], color[2])
}

fn load_color_map(path: &Path) -> Result<HashMap<String, [u8; 3]>, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read --origin-colors {}: {e}", path.display()))?;
    parse_color_map(&text).map_err(|e| format!("invalid --origin-colors {}: {e}", path.display()))
}

pub fn parse_color_map(text: &str) -> Result<HashMap<String, [u8; 3]>, String> {
    let raw: HashMap<String, String> = serde_json::from_str(text).map_err(|e| e.to_string())?;
    raw.into_iter()
        .map(|(host, value)| {
            let color = parse_hex_color(&value)
                .ok_or_else(|| format!("{host}: expected a #rrggbb colour, got {value:?}"))?;
            Ok((host.trim().to_ascii_lowercase(), color))
        })
        .collect()
}

/// Accent-tinted dark surface for `background_color`.
fn tint_background(accent: [u8; 3]) -> [u8; 3] {
    let mix = |a: u8, b: u8| ((u16::from(a) * 15 + u16::from(b) * 85) / 100) as u8;
    [
        mix(accent[0], NEW_GLYPH[0]),
        mix(accent[1], NEW_GLYPH[1]),
        mix(accent[2], NEW_GLYPH[2]),
    ]
}

pub fn build_manifest(stock: &[u8], host: &str, accent: [u8; 3]) -> Option<Vec<u8>> {
    let mut manifest: serde_json::Value = serde_json::from_slice(stock).ok()?;
    let object = manifest.as_object_mut()?;
    let name = format!("herdr · {}", display_name(host));
    object.insert("name".into(), name.clone().into());
    object.insert("short_name".into(), name.into());
    object.insert("theme_color".into(), hex(accent).into());
    object.insert(
        "background_color".into(),
        hex(tint_background(accent)).into(),
    );
    serde_json::to_vec_pretty(&manifest).ok()
}

pub fn recolor_svg(svg: &str, accent: [u8; 3]) -> String {
    svg.replace(&hex(STOCK_BACKGROUND), &hex(accent))
        .replace(&hex(STOCK_GLYPH), &hex(NEW_GLYPH))
}

/// Maps each pixel's position between the stock glyph and background colours onto the new glyph
/// and accent colours, which keeps antialiased edges smooth.
pub fn recolor_png(data: &[u8], accent: [u8; 3]) -> Option<Vec<u8>> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(data));
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    if info.bit_depth != png::BitDepth::Eight {
        return None;
    }
    let channels = match info.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        _ => return None,
    };
    let span = f32::from(STOCK_BACKGROUND[0]) - f32::from(STOCK_GLYPH[0]);
    for pixel in buf[..info.buffer_size()].chunks_exact_mut(channels) {
        let t = ((f32::from(pixel[0]) - f32::from(STOCK_GLYPH[0])) / span).clamp(0.0, 1.0);
        for c in 0..3 {
            let (from, to) = (f32::from(NEW_GLYPH[c]), f32::from(accent[c]));
            pixel[c] = (from + (to - from) * t).round() as u8;
        }
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, info.width, info.height);
    encoder.set_color(info.color_type);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().ok()?;
    writer.write_image_data(&buf[..info.buffer_size()]).ok()?;
    writer.finish().ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_with_host(host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_str(host).unwrap());
        headers
    }

    #[test]
    fn hostname_strips_port_and_ignores_forwarded_host() {
        assert_eq!(
            request_hostname(&headers_with_host("Mini0:8787")).as_deref(),
            Some("mini0")
        );
        assert_eq!(
            request_hostname(&headers_with_host("[::1]:8787")).as_deref(),
            Some("::1")
        );
        let mut headers = headers_with_host("mini0:8787");
        headers.insert("x-forwarded-host", HeaderValue::from_static("evil.example"));
        assert_eq!(request_hostname(&headers).as_deref(), Some("mini0"));
        assert_eq!(request_hostname(&HeaderMap::new()), None);
    }

    #[test]
    fn color_prefers_map_then_first_label_then_stable_hash() {
        let map =
            parse_color_map(r##"{"mini0": "#e06c75", "box.example.com": "#010203"}"##).unwrap();
        assert_eq!(resolve_color(&map, "mini0.tail.ts.net"), [0xe0, 0x6c, 0x75]);
        assert_eq!(resolve_color(&map, "box.example.com"), [1, 2, 3]);
        let a = resolve_color(&map, "macbook");
        assert_eq!(a, resolve_color(&map, "macbook"));
        assert_ne!(a, resolve_color(&map, "other-host"));
    }

    #[test]
    fn color_map_rejects_bad_values() {
        assert!(parse_color_map(r#"{"mini0": "red"}"#).is_err());
        assert!(parse_color_map("[]").is_err());
    }

    #[test]
    fn manifest_is_named_and_tinted_per_host() {
        let stock = br##"{"name":"herdr-web","short_name":"herdr","theme_color":"#11111b","icons":[{"src":"/x.png"}]}"##;
        let out = build_manifest(stock, "mini0.tail.ts.net", [0xe0, 0x6c, 0x75]).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(json["name"], "herdr · mini0");
        assert_eq!(json["short_name"], "herdr · mini0");
        assert_eq!(json["theme_color"], "#e06c75");
        assert_ne!(json["background_color"], "#e06c75");
        assert_eq!(json["icons"][0]["src"], "/x.png");
    }

    #[test]
    fn svg_swaps_stock_colors() {
        let svg = r##"<rect fill="#d9dad8"/><g fill="#303438"/>"##;
        assert_eq!(
            recolor_svg(svg, [0xe0, 0x6c, 0x75]),
            r##"<rect fill="#e06c75"/><g fill="#11111b"/>"##
        );
    }

    fn solid_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let data: Vec<u8> = (0..width * height).flat_map(|_| rgb).collect();
        writer.write_image_data(&data).unwrap();
        writer.finish().unwrap();
        out
    }

    fn first_pixel(data: &[u8]) -> [u8; 3] {
        let mut reader = png::Decoder::new(std::io::Cursor::new(data))
            .read_info()
            .unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut buf).unwrap();
        [buf[0], buf[1], buf[2]]
    }

    #[test]
    fn png_background_becomes_accent_and_glyph_becomes_dark() {
        let accent = [0xe0, 0x6c, 0x75];
        let bg = recolor_png(&solid_png(4, 4, STOCK_BACKGROUND), accent).unwrap();
        assert_eq!(first_pixel(&bg), accent);
        let glyph = recolor_png(&solid_png(4, 4, STOCK_GLYPH), accent).unwrap();
        assert_eq!(first_pixel(&glyph), NEW_GLYPH);
        assert!(recolor_png(b"not a png", accent).is_none());
    }

    #[test]
    fn responses_fall_back_to_stock_without_host_and_cache_per_color() {
        let dir = std::env::temp_dir().join(format!("herdr-origin-icons-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stock = solid_png(2, 2, STOCK_BACKGROUND);
        std::fs::write(dir.join("herdr-logo-192.png"), &stock).unwrap();
        let icons = OriginIcons::new(dir.clone(), None).unwrap();

        let plain = icons.png("herdr-logo-192.png", &HeaderMap::new());
        assert_eq!(plain.status(), StatusCode::OK);
        let tinted = icons.png("herdr-logo-192.png", &headers_with_host("mini0:8787"));
        assert_eq!(tinted.status(), StatusCode::OK);
        assert_eq!(tinted.headers().get(VARY).unwrap(), "Host");
        assert_eq!(icons.png_cache.lock().unwrap().len(), 1);
        assert_eq!(
            icons
                .png("missing.png", &headers_with_host("mini0"))
                .status(),
            StatusCode::NOT_FOUND
        );
        std::fs::remove_dir_all(dir).ok();
    }
}
