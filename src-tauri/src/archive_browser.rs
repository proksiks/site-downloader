use crate::{archive_file, read_archive_manifest, spawn_worker};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
};
use tauri::{ipc::Response, AppHandle};
use tauri_plugin_opener::OpenerExt;

const TEXT_LIMIT: u64 = 256 * 1024;
const IMAGE_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveFile {
    path: String,
    url: Option<String>,
    bytes: Option<u64>,
    category: &'static str,
    variant: &'static str,
    preview: Option<&'static str>,
}

fn safe_relative(path: &Path) -> bool {
    let mut parts = path.components().peekable();
    parts.peek().is_some() && parts.all(|part| matches!(part, Component::Normal(_)))
}

fn classify(path: &str, content_type: &str) -> (&'static str, Option<&'static str>) {
    let extension = Path::new(path)
        .extension()
        .and_then(|part| part.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = content_type.split(';').next().unwrap_or_default().trim();
    let image_preview = match (extension.as_str(), mime) {
        ("png", _) | (_, "image/png") => Some("image/png"),
        ("jpg" | "jpeg", _) | (_, "image/jpeg") => Some("image/jpeg"),
        ("webp", _) | (_, "image/webp") => Some("image/webp"),
        ("gif", _) | (_, "image/gif") => Some("image/gif"),
        ("avif", _) | (_, "image/avif") => Some("image/avif"),
        _ => None,
    };
    if path.starts_with("3d/")
        || mime.starts_with("model/")
        || matches!(
            extension.as_str(),
            "gltf"
                | "glb"
                | "obj"
                | "fbx"
                | "dae"
                | "ply"
                | "stl"
                | "usdz"
                | "usd"
                | "usdc"
                | "usda"
                | "ktx"
                | "ktx2"
                | "dds"
                | "basis"
                | "hdr"
                | "exr"
                | "drc"
                | "mesh"
                | "meshopt"
                | "splat"
                | "spz"
        )
    {
        return (
            "scene",
            if extension == "gltf" {
                Some("text/plain")
            } else {
                image_preview
            },
        );
    }
    match (extension.as_str(), mime) {
        ("html" | "htm" | "xhtml", _) | (_, "text/html" | "application/xhtml+xml") => {
            ("html", Some("text/plain"))
        }
        ("js" | "cjs" | "mjs" | "jsx" | "ts" | "tsx", _)
        | (
            _,
            "application/javascript"
            | "text/javascript"
            | "application/ecmascript"
            | "text/ecmascript",
        ) => ("js", Some("text/plain")),
        ("css", _) | (_, "text/css") => ("css", Some("text/plain")),
        ("json" | "map" | "xml" | "csv", _) | (_, "application/json" | "application/xml") => {
            ("data", Some("text/plain"))
        }
        ("woff" | "woff2" | "ttf" | "otf" | "eot", _) => ("fonts", None),
        (
            "mp4" | "m4a" | "m4v" | "mp3" | "ogg" | "ogv" | "wav" | "webm" | "aac" | "mov" | "m3u8",
            _,
        ) => ("media", None),
        ("svg", _) | (_, "image/svg+xml") => ("images", Some("text/plain")),
        ("bmp" | "ico" | "tiff" | "tif", _) => ("images", None),
        _ if image_preview.is_some() || mime.starts_with("image/") => ("images", image_preview),
        _ if mime.starts_with("font/") => ("fonts", None),
        _ if mime.starts_with("video/") || mime.starts_with("audio/") => ("media", None),
        _ if mime.starts_with("text/")
            || matches!(extension.as_str(), "txt" | "md" | "glsl" | "wgsl") =>
        {
            ("other", Some("text/plain"))
        }
        _ => ("other", None),
    }
}

fn collect_files(root: &Path, manifest: &Value) -> BTreeMap<String, ArchiveFile> {
    let mut files = BTreeMap::new();
    let mut add = |entry: &Value, key: &str, variant| {
        let Some(path) = entry[key].as_str() else {
            return;
        };
        if !safe_relative(Path::new(path)) {
            return;
        }
        let content_type = entry["contentType"].as_str().unwrap_or_default();
        let (category, preview) = classify(path, content_type);
        files.entry(path.to_owned()).or_insert_with(|| ArchiveFile {
            path: path.to_owned(),
            url: entry["url"]
                .as_str()
                .or_else(|| entry["model"].as_str())
                .map(str::to_owned),
            bytes: entry["bytes"].as_u64().filter(|_| key == "file"),
            category,
            variant,
            preview,
        });
    };

    for entry in manifest["files"].as_array().into_iter().flatten() {
        add(entry, "file", "original");
    }
    for page in manifest["pages"].as_array().into_iter().flatten() {
        if page["offlineFile"]
            .as_str()
            .is_some_and(|path| crate::offline_entry(path).is_some())
        {
            add(page, "offlineFile", "snapshot");
        }
    }
    let scene_manifest = Path::new("3d/manifest.json");
    if archive_file(root, scene_manifest) {
        let scene = fs::read(root.join(scene_manifest))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        if let Some(scene) = scene {
            for field in ["assets", "embedded"] {
                for entry in scene[field].as_array().into_iter().flatten() {
                    if entry["file"]
                        .as_str()
                        .is_some_and(|path| path.starts_with("3d/"))
                    {
                        add(entry, "file", "export");
                    }
                }
            }
        }
    }
    files
}

fn resolve_entry(directory: &Path, path: &str) -> Result<(PathBuf, ArchiveFile), String> {
    let (root, manifest) = read_archive_manifest(directory)?;
    let file = collect_files(&root, &manifest)
        .remove(path)
        .filter(|_| archive_file(&root, Path::new(path)))
        .ok_or("Файл архива не найден.")?;
    Ok((directory.join(path), file))
}

#[tauri::command]
pub async fn list_archive_files(directory: PathBuf) -> Result<Vec<ArchiveFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, manifest) = read_archive_manifest(&directory)?;
        Ok(collect_files(&root, &manifest).into_values().collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn preview_archive_file(directory: PathBuf, path: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, entry) = resolve_entry(&directory, &path)?;
        let preview = entry.preview.ok_or("Просмотр этого формата недоступен.")?;
        let file = File::open(path).map_err(|_| "Не удалось прочитать файл.")?;
        let limit = if preview == "text/plain" {
            TEXT_LIMIT
        } else {
            IMAGE_LIMIT
        };
        let mut bytes = Vec::new();
        file.take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Не удалось прочитать файл.")?;
        if preview != "text/plain" && bytes.len() as u64 > limit {
            return Err("Картинка больше 8 МБ. Открой её из папки архива.".into());
        }
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn reveal_archive_file(app: AppHandle, directory: PathBuf, path: String) -> Result<(), String> {
    let (path, _) = resolve_entry(&directory, &path)?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| format!("Не удалось показать файл. {error}"))
}

#[tauri::command]
pub async fn analyze_archive_javascript(
    app: AppHandle,
    directory: PathBuf,
    path: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (file, entry) = resolve_entry(&directory, &path)?;
        if entry.category != "js" {
            return Err("Выбери файл JavaScript.".into());
        }
        let mut worker = spawn_worker(&app, &["--analyze-js".into(), file.into_os_string()])?;
        // Keep control stdin open until the worker has finished.
        let stdin = worker.stdin.take();
        let output = worker
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        drop(stdin);
        let event: Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| "Не удалось разобрать JavaScript.")?;
        if output.status.success() && event["type"] == "analysis" {
            return Ok(event["result"].clone());
        }
        Err(event["message"]
            .as_str()
            .unwrap_or("Не удалось разобрать JavaScript.")
            .into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_web_assets_and_bounds_archive_paths() {
        assert_eq!(
            classify("assets/site/chunk.js", ""),
            ("js", Some("text/plain"))
        );
        assert_eq!(
            classify("assets/site/image", "image/png"),
            ("images", Some("image/png"))
        );
        assert_eq!(
            classify("assets/site/texture.ktx2", "image/ktx2"),
            ("scene", None)
        );
        assert_eq!(
            classify("3d/textures/embedded/image-1.png", ""),
            ("scene", Some("image/png"))
        );
        assert_eq!(
            classify("offline/docs/index.html", "text/html"),
            ("html", Some("text/plain"))
        );
        assert!(safe_relative(Path::new("assets/site/index.js")));
        assert!(!safe_relative(Path::new("assets/../../private")));
        assert!(!safe_relative(Path::new("/absolute/file")));
    }

    #[test]
    fn indexes_original_files_and_html_snapshots_once() {
        let manifest = serde_json::json!({
            "files": [
                {"file":"posts/index.html","offlineFile":"offline/posts/index.html","bytes":500},
                {"file":"assets/site/theme.css","bytes":20},
                {"file":"../private.txt","bytes":20},
                {"file":"posts/index.html","bytes":500}
            ],
            "pages": [{"file":"posts/index.html","offlineFile":"offline/posts/index.html","bytes":500}]
        });
        let files = collect_files(Path::new("/path-not-used-by-this-test"), &manifest);
        assert_eq!(files.len(), 3);
        assert_eq!(files["assets/site/theme.css"].category, "css");
        assert_eq!(files["posts/index.html"].bytes, Some(500));
        assert_eq!(files["offline/posts/index.html"].variant, "snapshot");
        assert_eq!(files["offline/posts/index.html"].bytes, None);
    }
}
