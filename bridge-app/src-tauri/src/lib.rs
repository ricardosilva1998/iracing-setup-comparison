use anyhow::Context;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Settings {
    server_url: String,
    iracing_root: String,
    // Computed at read time from the keychain — not stored in the JSON file.
    #[serde(default)]
    has_credentials: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    server_url: String,
    iracing_root: String,
}

// ---------------------------------------------------------------------------
// Download types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadArgs {
    car_slug: String,
    season_label: String,
    track_slug: String,
    shop_slug: String,
    datapack_id: String,
    /// iRacing-internal setup folder name for this car (e.g. "porsche9922cup").
    /// When present, used verbatim as the car-level folder instead of slugifying
    /// car_slug. Falls back to slugify(car_slug) when None or empty — preserves
    /// the v0.1.4 contract so older callers that omit this field still work.
    iracing_folder_name: Option<String>,
    /// Canonical car name from the server API (e.g. "Porsche 911 GT3 R (992)").
    /// Used to look up a persisted folder override in car-folders.json when
    /// iracing_folder_name is absent. Additive field — v0.1.x callers that omit
    /// it continue to work unchanged.
    car_name: Option<String>,
    /// Explicit ZIP download URL supplied by the caller (used for HYMO and any
    /// future shop whose zip endpoint differs from the GnG pattern).
    /// When Some: used directly instead of constructing the URL from datapack_id.
    /// When None: falls back to the existing GnG pattern
    ///   (<serverUrl>/api/files/<datapack_id>/zip).
    /// The URL is validated to share the same origin as server_url to prevent
    /// SSRF. Additive field — callers that omit it keep the existing behaviour.
    asset_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadResult {
    saved_to: String,
    file_names: Vec<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEYRING_SERVICE: &str = "iracing-setup-bridge";
const CONFIG_DIR: &str = "iracing-setup-bridge";
const CONFIG_FILE: &str = "config.json";

fn config_path() -> anyhow::Result<PathBuf> {
    let dir = dirs::config_dir()
        .context("could not locate OS config directory")?
        .join(CONFIG_DIR);
    fs::create_dir_all(&dir).context("could not create config directory")?;
    Ok(dir.join(CONFIG_FILE))
}

/// Lowercase, spaces/underscores to hyphens, strip non-[a-z0-9-], collapse
/// repeated hyphens, trim leading/trailing hyphens.
fn slugify(s: &str) -> String {
    let lower = s.to_lowercase();
    let replaced: String = lower
        .chars()
        .map(|c| if c == ' ' || c == '_' { '-' } else { c })
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    let mut result = String::with_capacity(replaced.len());
    let mut prev_hyphen = false;
    for c in replaced.chars() {
        if c == '-' {
            if !prev_hyphen {
                result.push(c);
            }
            prev_hyphen = true;
        } else {
            result.push(c);
            prev_hyphen = false;
        }
    }
    result.trim_matches('-').to_string()
}

/// Slugify and reject empty results (directory traversal guard).
fn safe_segment(s: &str) -> anyhow::Result<String> {
    let slug = slugify(s);
    if slug.is_empty() {
        anyhow::bail!("segment slugified to empty string: {:?}", s);
    }
    Ok(slug)
}

/// Validate a relative path that may contain multiple segments separated by `/` or `\`
/// (e.g. "porsche9922cup", "porsche9922cup/myfolder", "mx5 mx52016/my folder").
/// Each segment is trimmed and validated: non-empty, not `.`, not `..`, no `:` (blocks
/// Windows drive letters). Segments are rejoined with the platform separator.
/// Rejects absolute paths, drive-letter prefixes, and any traversal-enabling segment.
fn safe_relative_path(s: &str) -> anyhow::Result<String> {
    if s.trim().is_empty() {
        anyhow::bail!("empty folder path");
    }
    // Reject absolute paths (POSIX / or Windows \)
    if s.starts_with('/') || s.starts_with('\\') {
        anyhow::bail!("absolute path not allowed: {:?}", s);
    }
    // Reject Windows drive letter prefixes (e.g. "C:\", "C:/")
    if s.len() >= 2 && s.chars().nth(1) == Some(':') {
        anyhow::bail!("absolute path not allowed: {:?}", s);
    }

    let segments: Vec<&str> = s
        .split(|c| c == '/' || c == '\\')
        .filter(|seg| !seg.is_empty())
        .collect();

    if segments.is_empty() {
        anyhow::bail!("empty folder path after splitting");
    }

    for seg in &segments {
        let trimmed = seg.trim();
        if trimmed.is_empty() {
            anyhow::bail!("invalid path segment (blank): {:?}", seg);
        }
        if trimmed == "." || trimmed == ".." {
            anyhow::bail!("invalid path segment (traversal): {:?}", seg);
        }
        if trimmed.contains(':') {
            anyhow::bail!("invalid path segment (colon): {:?}", seg);
        }
        // Defensive: split already stripped separators, but guard explicitly.
        if trimmed.contains('/') || trimmed.contains('\\') {
            anyhow::bail!("invalid path segment (contains separator): {:?}", seg);
        }
    }

    let joined = segments
        .iter()
        .map(|s| s.trim())
        .collect::<Vec<_>>()
        .join(std::path::MAIN_SEPARATOR_STR);

    Ok(joined)
}

#[cfg(test)]
mod tests {
    use super::safe_relative_path;

    #[test]
    fn single_segment_accepted() {
        assert_eq!(safe_relative_path("porsche9922cup").unwrap(), "porsche9922cup");
    }

    #[test]
    fn multi_segment_accepted() {
        let result = safe_relative_path("porsche9922cup/myfolder").unwrap();
        assert!(result.contains("porsche9922cup"));
        assert!(result.contains("myfolder"));
        assert!(!result.contains(".."));
    }

    #[test]
    fn dotdot_rejected() {
        assert!(safe_relative_path("../foo").is_err());
        assert!(safe_relative_path("foo/../bar").is_err());
    }

    #[test]
    fn absolute_posix_rejected() {
        assert!(safe_relative_path("/absolute/path").is_err());
    }

    #[test]
    fn windows_drive_rejected() {
        assert!(safe_relative_path("C:\\foo").is_err());
        assert!(safe_relative_path("C:/foo").is_err());
    }

    #[test]
    fn empty_rejected() {
        assert!(safe_relative_path("").is_err());
        assert!(safe_relative_path("   ").is_err());
    }

    #[test]
    fn dot_segment_rejected() {
        assert!(safe_relative_path("./foo").is_err());
    }

    #[test]
    fn spaces_in_segments_preserved() {
        let result = safe_relative_path("mx5 mx52016/my folder").unwrap();
        assert!(result.contains("mx5 mx52016"));
        assert!(result.contains("my folder"));
    }
}

// ---------------------------------------------------------------------------
// Car folder override storage
// ---------------------------------------------------------------------------

const CAR_FOLDERS_FILE: &str = "car-folders.json";

fn car_folders_path() -> Result<PathBuf, String> {
    let mut p = dirs::config_dir().ok_or_else(|| "config dir unavailable".to_string())?;
    p.push(CONFIG_DIR);
    fs::create_dir_all(&p).map_err(|e| format!("create dir failed: {}", e))?;
    p.push(CAR_FOLDERS_FILE);
    Ok(p)
}

fn read_car_folders() -> Result<HashMap<String, String>, String> {
    let path = car_folders_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("read failed: {}", e))?;
    serde_json::from_str::<HashMap<String, String>>(&text)
        .map_err(|e| format!("parse failed: {}", e))
}

fn write_car_folders(map: &HashMap<String, String>) -> Result<(), String> {
    let path = car_folders_path()?;
    let text =
        serde_json::to_string_pretty(map).map_err(|e| format!("serialise failed: {}", e))?;
    fs::write(&path, text).map_err(|e| format!("write failed: {}", e))?;
    Ok(())
}

#[tauri::command]
fn get_car_folder_overrides() -> Result<HashMap<String, String>, String> {
    read_car_folders()
}

#[tauri::command]
fn save_car_folder_override(car_name: String, folder: String) -> Result<(), String> {
    if car_name.trim().is_empty() {
        return Err("empty car name".into());
    }
    // Validate the folder path via the existing traversal-safety helper.
    let cleaned = safe_relative_path(&folder).map_err(|e| e.to_string())?;
    let mut map = read_car_folders()?;
    map.insert(car_name.trim().to_string(), cleaned);
    write_car_folders(&map)?;
    Ok(())
}

#[tauri::command]
fn clear_car_folder_override(car_name: String) -> Result<(), String> {
    let mut map = read_car_folders()?;
    map.remove(car_name.trim());
    write_car_folders(&map)?;
    Ok(())
}

/// Load password for the fixed "admin" account from the OS keychain.
fn load_credentials() -> anyhow::Result<String> {
    let entry = Entry::new(KEYRING_SERVICE, "admin")
        .context("could not open keychain entry")?;
    entry.get_password().context("could not read password from keychain")
}

fn read_settings_file() -> anyhow::Result<SettingsFile> {
    let path = config_path()?;
    if !path.exists() {
        anyhow::bail!("settings not configured — open Settings to set up the app");
    }
    let raw = fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw)?)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    let path = config_path().map_err(|e| e.to_string())?;

    let file: SettingsFile = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())?
    } else {
        let default_root = dirs::document_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("iRacing")
            .join("setups")
            .to_string_lossy()
            .to_string();
        SettingsFile {
            server_url: "https://iracing-setup-comparison-production.up.railway.app".to_string(),
            iracing_root: default_root,
        }
    };

    let has_credentials = Entry::new(KEYRING_SERVICE, "admin")
        .map(|e| e.get_password().is_ok())
        .unwrap_or(false);

    Ok(Settings {
        server_url: file.server_url,
        iracing_root: file.iracing_root,
        has_credentials,
    })
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    let path = config_path().map_err(|e| e.to_string())?;
    let file = SettingsFile {
        server_url: settings.server_url,
        iracing_root: settings.iracing_root,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_credentials(username: String, password: String) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &username).map_err(|e| e.to_string())?;
    entry.set_password(&password).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
struct ConnectionResult {
    ok: bool,
    message: String,
}

#[tauri::command]
fn test_connection() -> Result<ConnectionResult, String> {
    let file = read_settings_file().map_err(|e| e.to_string())?;
    let password = match load_credentials() {
        Ok(p) => p,
        Err(_) => {
            return Ok(ConnectionResult {
                ok: false,
                message: "No credentials saved. Enter your admin password in Settings.".to_string(),
            })
        }
    };

    let url = format!("{}/admin", file.server_url.trim_end_matches('/'));
    let resp = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .basic_auth("admin", Some(&password))
        .send()
        .map_err(|e| format!("network error: {}", e))?;

    if resp.status().is_success() {
        Ok(ConnectionResult {
            ok: true,
            message: "Connected successfully.".to_string(),
        })
    } else if resp.status() == 401 {
        Ok(ConnectionResult {
            ok: false,
            message: "Authentication failed — wrong username or password.".to_string(),
        })
    } else {
        Ok(ConnectionResult {
            ok: false,
            message: format!("Server returned HTTP {}", resp.status()),
        })
    }
}

#[tauri::command]
fn fetch_picker(endpoint: String) -> Result<serde_json::Value, String> {
    let file = read_settings_file().map_err(|e| e.to_string())?;

    // Strip any leading slash; the picker endpoints are all under /api/picker/.
    let clean = endpoint.trim_start_matches('/');
    let url = format!("{}/api/picker/{}", file.server_url.trim_end_matches('/'), clean);

    let resp = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .map_err(|e| format!("network error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("picker endpoint returned HTTP {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .map_err(|e| format!("JSON parse error: {}", e))
}

#[tauri::command]
fn download_setups(args: DownloadArgs) -> Result<DownloadResult, String> {
    let file = read_settings_file().map_err(|e| e.to_string())?;
    let password = load_credentials().map_err(|e| e.to_string())?;

    // Determine the car-level folder name. Priority order:
    //   1. Caller-supplied iracing_folder_name (highest — frontend explicit choice).
    //   2. Persisted override for the canonical car_name in car-folders.json.
    //   3. Slugify car_slug (existing fallback; preserves v0.1.x contract).
    let car_folder = if let Some(name) = args.iracing_folder_name.as_deref() {
        if !name.trim().is_empty() {
            safe_relative_path(name.trim()).map_err(|e| e.to_string())?
        } else {
            // Empty string supplied — fall through to override / slug.
            let override_folder = args
                .car_name
                .as_deref()
                .filter(|n| !n.trim().is_empty())
                .and_then(|n| read_car_folders().ok()?.remove(n.trim()));
            match override_folder {
                Some(f) => f,
                None => safe_segment(&args.car_slug).map_err(|e| e.to_string())?,
            }
        }
    } else {
        // iracing_folder_name absent — check persisted overrides before slugifying.
        let override_folder = args
            .car_name
            .as_deref()
            .filter(|n| !n.trim().is_empty())
            .and_then(|n| read_car_folders().ok()?.remove(n.trim()));
        match override_folder {
            Some(f) => f,
            None => safe_segment(&args.car_slug).map_err(|e| e.to_string())?,
        }
    };
    let season_label = safe_segment(&args.season_label).map_err(|e| e.to_string())?;
    let track_slug = safe_segment(&args.track_slug).map_err(|e| e.to_string())?;
    let shop_slug = safe_segment(&args.shop_slug).map_err(|e| e.to_string())?;

    // Validate datapack_id — alphanumerics, hyphens, underscores, 4–40 chars.
    let id = &args.datapack_id;
    if id.len() < 4
        || id.len() > 40
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid datapack_id: {}", id));
    }

    // Build: <iracingRoot>/<carFolder>/<seasonLabel>/<trackSlug>/<shopSlug>/
    let target_dir = PathBuf::from(&file.iracing_root)
        .join(&car_folder)
        .join(&season_label)
        .join(&track_slug)
        .join(&shop_slug);

    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("could not create target directory: {}", e))?;

    // Build the ZIP URL. When the caller provides an explicit asset_url, use it
    // directly (HYMO and future shops). Validate that it shares the same origin
    // as server_url to prevent SSRF — a compromised frontend cannot redirect the
    // bridge to an arbitrary host.
    let zip_url = if let Some(ref url) = args.asset_url {
        let configured_origin = {
            let base = file.server_url.trim_end_matches('/');
            // Extract origin: everything up to and including the host[:port].
            match url::Url::parse(base) {
                Ok(u) => format!(
                    "{}://{}",
                    u.scheme(),
                    u.host_str().unwrap_or("")
                ),
                Err(_) => return Err(format!("invalid server_url: {}", base)),
            }
        };
        let asset_origin = match url::Url::parse(url) {
            Ok(u) => format!(
                "{}://{}",
                u.scheme(),
                u.host_str().unwrap_or("")
            ),
            Err(_) => return Err(format!("invalid asset_url: {}", url)),
        };
        if asset_origin != configured_origin {
            return Err(format!(
                "asset_url origin '{}' does not match configured server origin '{}'",
                asset_origin, configured_origin
            ));
        }
        url.clone()
    } else {
        format!(
            "{}/api/files/{}/zip",
            file.server_url.trim_end_matches('/'),
            id
        )
    };

    let mut resp = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?
        .get(&zip_url)
        .basic_auth("admin", Some(&password))
        .send()
        .map_err(|e| format!("network error downloading zip: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("zip endpoint returned HTTP {}", resp.status()));
    }

    let mut body: Vec<u8> = Vec::new();
    resp.read_to_end(&mut body)
        .map_err(|e| format!("error reading response body: {}", e))?;

    let cursor = std::io::Cursor::new(body);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("invalid zip archive: {}", e))?;

    let mut written: Vec<String> = Vec::new();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip read error: {}", e))?;

        if entry.is_dir() {
            continue;
        }

        // Use only the base filename — discard any directory prefix in the zip.
        let raw_name = entry
            .name()
            .rsplit('/')
            .next()
            .unwrap_or(entry.name())
            .to_string();

        // Reject unsafe filenames before writing.
        if raw_name.is_empty()
            || raw_name.contains("..")
            || !raw_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._- ".contains(c))
        {
            continue;
        }

        let dest = target_dir.join(&raw_name);
        let mut out =
            fs::File::create(&dest).map_err(|e| format!("could not create {}: {}", raw_name, e))?;

        let mut buf: Vec<u8> = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("could not read zip entry {}: {}", raw_name, e))?;

        out.write_all(&buf)
            .map_err(|e| format!("could not write {}: {}", raw_name, e))?;

        written.push(raw_name);
    }

    Ok(DownloadResult {
        saved_to: target_dir.to_string_lossy().to_string(),
        file_names: written,
    })
}

// ---------------------------------------------------------------------------
// Library entry point (called by main.rs shim)
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            save_credentials,
            test_connection,
            fetch_picker,
            download_setups,
            get_car_folder_overrides,
            save_car_folder_override,
            clear_car_folder_override,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
