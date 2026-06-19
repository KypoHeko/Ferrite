use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ============================================================
// Embedded skins. The entire src-tauri/skins folder is baked
// into the binary — adding skins/<id>.json requires only a
// rebuild, no code changes. Embedded skins are read straight
// from the binary; user skins come from disk (config/skins/<id>/skin.json).
// ============================================================
static EMBEDDED_SKINS: Dir = include_dir!("$CARGO_MANIFEST_DIR/skins");

// ============================================================
// Allowlist: what a skin MAY override. Everything else in
// skin.json is silently discarded — this is the trust boundary.
// ============================================================
const SKINNABLE_TOKENS: &[&str] = &[
    "--accent-rgb",
    "--bg",
    "--shell-1",
    "--shell-2",
    "--shell-3",
    "--titlebar-1",
    "--titlebar-2",
    "--inset",
    "--panel-bg",
    "--danger-rgb",
    "--font-mono",
    "--font-sans",
];
const SKINNABLE_ASSETS: &[&str] = &["--bg-image"];
const MAX_TOKEN_LEN: usize = 200;
const MAX_ASSET_BYTES: u64 = 4 * 1024 * 1024; // 4 MB per image

#[derive(Deserialize)]
struct SkinFile {
    name: Option<String>,
    author: Option<String>,
    #[serde(default)]
    tokens: HashMap<String, String>,
    #[serde(default)]
    assets: HashMap<String, String>,
}

#[derive(Serialize)]
pub struct SkinMeta {
    id: String,
    name: String,
    author: String,
    builtin: bool,
}

#[derive(Serialize)]
pub struct SkinData {
    name: String,
    tokens: HashMap<String, String>,
    assets: HashMap<String, String>, // token name -> data-URI
}

// ---- paths ----
fn skins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(base.join("skins"))
}

fn selected_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(skins_dir(app)?.join(".selected"))
}

// id comes from the frontend — don't let it roam the filesystem.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains("..")
        && !id.contains(['/', '\\', ':'])
}

// ---- embedded skins (from the binary) ----
fn embedded_skin(id: &str) -> Option<SkinFile> {
    let file = EMBEDDED_SKINS.get_file(format!("{id}.json"))?;
    let text = file.contents_utf8()?;
    serde_json::from_str::<SkinFile>(text).ok()
}

// ---- token value validation ----
// Token values must not contain characters that could break a CSS declaration.
// setProperty already prevents escaping into a new rule, but this is defence
// in depth and gives skin authors a clear rejection message.
fn valid_token_value(v: &str) -> bool {
    v.len() <= MAX_TOKEN_LEN && !v.chars().any(|c| matches!(c, '{' | '}' | '<' | '>' | ';'))
}

fn sanitize_tokens(raw: HashMap<String, String>) -> HashMap<String, String> {
    raw.into_iter()
        .filter(|(k, v)| SKINNABLE_TOKENS.contains(&k.as_str()) && valid_token_value(v))
        .collect()
}

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

// Skin images are converted to data-URIs here so that file paths never leak
// to the frontend (no fuss with the asset protocol or CSP).
fn resolve_assets(folder: &Path, raw: HashMap<String, String>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let folder_canon = match folder.canonicalize() {
        Ok(p) => p,
        Err(_) => return out,
    };
    for (k, v) in raw {
        if !SKINNABLE_ASSETS.contains(&k.as_str()) {
            continue;
        }
        // already a data-URI — accept only a valid image/base64 without quotes
        // (a quote would break the url() token on the frontend), with headroom for base64
        if v.starts_with("data:") {
            if v.starts_with("data:image/")
                && v.contains(";base64,")
                && !v.contains('"')
                && (v.len() as u64) <= MAX_ASSET_BYTES * 2
            {
                out.insert(k, v);
            }
            continue;
        }
        // otherwise — a relative path INSIDE the skin folder
        let candidate = folder.join(&v);
        let canon = match candidate.canonicalize() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !canon.starts_with(&folder_canon) {
            continue; // guard against ../ escaping the skin folder
        }
        let ext = canon.extension().and_then(|e| e.to_str()).unwrap_or("");
        let mime = match image_mime(ext) {
            Some(m) => m,
            None => continue,
        };
        match fs::metadata(&canon) {
            Ok(m) if m.len() <= MAX_ASSET_BYTES => {}
            _ => continue,
        }
        let bytes = match fs::read(&canon) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        out.insert(k, format!("data:{mime};base64,{b64}"));
    }
    out
}

fn default_meta() -> SkinMeta {
    SkinMeta {
        id: "default".into(),
        name: "Default".into(),
        author: "Ferrite".into(),
        builtin: true,
    }
}

// ============================================================
// Commands
// ============================================================

// "Refresh" on the frontend = just calling this command again:
// embedded skins are read from the binary, the disk is rescanned,
// so a skin added to config/skins/<id>/ appears without a rebuild.
#[tauri::command]
pub fn list_skins(app: AppHandle) -> Vec<SkinMeta> {
    let mut list = vec![default_meta()];

    // embedded — from the binary, always available
    let mut builtins: Vec<SkinMeta> = EMBEDDED_SKINS
        .files()
        .filter_map(|f| {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                return None;
            }
            let id = p.file_stem()?.to_str()?.to_string();
            if !valid_id(&id) {
                return None;
            }
            let sf = serde_json::from_str::<SkinFile>(f.contents_utf8()?).ok()?;
            Some(SkinMeta {
                name: sf.name.unwrap_or_else(|| id.clone()),
                author: sf.author.unwrap_or_else(|| "Ferrite".into()),
                builtin: true,
                id,
            })
        })
        .collect();
    builtins.sort_by_key(|m| m.name.to_lowercase());

    // user skins — from disk; names that clash with embedded skins are hidden
    let embedded: HashSet<String> = builtins.iter().map(|m| m.id.clone()).collect();
    let mut users: Vec<SkinMeta> = Vec::new();
    if let Ok(dir) = skins_dir(&app) {
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.flatten() {
                let path = e.path();
                if !path.is_dir() {
                    continue;
                }
                let id = e.file_name().to_string_lossy().to_string();
                if !valid_id(&id) || embedded.contains(&id) {
                    continue;
                }
                if let Ok(text) = fs::read_to_string(path.join("skin.json")) {
                    if let Ok(f) = serde_json::from_str::<SkinFile>(&text) {
                        users.push(SkinMeta {
                            name: f.name.unwrap_or_else(|| id.clone()),
                            author: f.author.unwrap_or_else(|| "—".into()),
                            builtin: false,
                            id,
                        });
                    }
                }
            }
        }
    }
    users.sort_by_key(|m| m.name.to_lowercase());

    list.extend(builtins);
    list.extend(users);
    list
}

#[tauri::command]
pub fn load_skin(app: AppHandle, id: String) -> Result<SkinData, String> {
    // "default" = revert to tokens.css (no overrides)
    if id == "default" {
        return Ok(SkinData {
            name: "Default".into(),
            tokens: HashMap::new(),
            assets: HashMap::new(),
        });
    }
    if !valid_id(&id) {
        return Err(format!("invalid id: {id}"));
    }

    // embedded (from the binary)? — no images for now
    if let Some(f) = embedded_skin(&id) {
        return Ok(SkinData {
            name: f.name.unwrap_or_else(|| id.clone()),
            tokens: sanitize_tokens(f.tokens),
            assets: HashMap::new(),
        });
    }

    // user skin (from disk) — may carry --bg-image
    let folder = skins_dir(&app)?.join(&id);
    let text =
        fs::read_to_string(folder.join("skin.json")).map_err(|_| format!("skin not found: {id}"))?;
    let f: SkinFile = serde_json::from_str(&text).map_err(|e| format!("skin.json error: {e}"))?;

    Ok(SkinData {
        name: f.name.unwrap_or_else(|| id.clone()),
        tokens: sanitize_tokens(f.tokens),
        assets: resolve_assets(&folder, f.assets),
    })
}

#[tauri::command]
pub fn get_selected_skin(app: AppHandle) -> String {
    selected_path(&app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".into())
}

#[tauri::command]
pub fn set_selected_skin(app: AppHandle, id: String) -> Result<(), String> {
    if id != "default" {
        if !valid_id(&id) {
            return Err(format!("invalid id: {id}"));
        }
        if embedded_skin(&id).is_none() {
            let folder = skins_dir(&app)?.join(&id);
            if !folder.join("skin.json").exists() {
                return Err(format!("skin not found: {id}"));
            }
        }
    }
    let dir = skins_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(".selected"), id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_skins_dir(app: AppHandle) -> Result<(), String> {
    let dir = skins_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&dir).spawn();

    spawned.map(|_| ()).map_err(|e| e.to_string())
}
