#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Channel, path::BaseDirectory, AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

mod archive_browser;

#[derive(Default)]
struct CaptureState(Mutex<Option<ChildStdin>>);

#[derive(Default)]
struct ReplayState(Mutex<Option<ChildStdin>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveInfo {
    folder: PathBuf,
    offline_html: Option<PathBuf>,
    has_scene_assets: bool,
}

fn offline_entry(file: &str) -> Option<PathBuf> {
    let path = Path::new(file);
    let mut components = path.components();
    if components.next() != Some(Component::Normal("offline".as_ref()))
        || !components.all(|part| matches!(part, Component::Normal(_)))
        || path.extension() != Some("html".as_ref())
    {
        return None;
    }
    Some(path.to_path_buf())
}

fn archive_file(root: &Path, path: &Path) -> bool {
    root.join(path)
        .canonicalize()
        .is_ok_and(|file| file.starts_with(root) && file.is_file())
}

fn read_archive_manifest(directory: &Path) -> Result<(PathBuf, Value), String> {
    if !directory.is_absolute() {
        return Err("Выбери папку архива.".into());
    }
    let root = directory
        .canonicalize()
        .map_err(|_| "Не удалось открыть папку архива.")?;
    let manifest_path = Path::new("manifest.json");
    if !archive_file(&root, manifest_path) {
        return Err("Выбери папку архива, в которой находится manifest.json.".into());
    }
    let content =
        fs::read(root.join(manifest_path)).map_err(|_| "Не удалось прочитать manifest.json.")?;
    let manifest: Value =
        serde_json::from_slice(&content).map_err(|_| "В manifest.json ошибочный формат.")?;
    if !manifest["files"].is_array() {
        return Err("В manifest.json нет списка файлов архива.".into());
    }
    Ok((root, manifest))
}

fn read_archive_info(directory: PathBuf) -> Result<ArchiveInfo, String> {
    let (root, manifest) = read_archive_manifest(&directory)?;
    let offline_html = manifest["offlineEntryFile"]
        .as_str()
        .and_then(offline_entry)
        .filter(|path| archive_file(&root, path))
        .or_else(|| {
            let default = PathBuf::from("offline/index.html");
            archive_file(&root, &default).then_some(default)
        });
    Ok(ArchiveInfo {
        folder: directory,
        offline_html,
        has_scene_assets: archive_file(&root, Path::new("3d/manifest.json")),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRequest {
    url: String,
    directory: PathBuf,
    wait_seconds: u8,
    page_limit: u8,
    #[serde(default)]
    options: CaptureOptions,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct CaptureOptions {
    login: bool,
    include_paths: String,
    exclude_paths: String,
    skip_video: bool,
    manual_scene: bool,
}

fn node_candidates(app: &AppHandle) -> Vec<OsString> {
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("SITE_DOWNLOADER_NODE") {
        candidates.push(path);
    }
    if let Some(node) = bundled_node(app) {
        candidates.push(node.into_os_string());
    }
    candidates.push("node".into());

    #[cfg(unix)]
    {
        candidates.extend(
            [
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
            ]
            .map(OsString::from),
        );
        if let Ok(home) = app.path().home_dir() {
            if let Ok(versions) = home.join(".nvm/versions/node").read_dir() {
                let mut versions: Vec<_> = versions.flatten().collect();
                versions.sort_by_cached_key(|entry| {
                    let version = entry.file_name();
                    let mut parts = version
                        .to_str()
                        .unwrap_or_default()
                        .trim_start_matches('v')
                        .split('.')
                        .map(|part| part.parse::<u32>().unwrap_or_default());
                    (parts.next(), parts.next(), parts.next())
                });
                candidates.extend(
                    versions
                        .into_iter()
                        .rev()
                        .map(|entry| entry.path().join("bin/node").into_os_string()),
                );
            }
        }
    }
    candidates
}

fn bundled_node(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    app.path()
        .resolve(Path::new("runtime").join(name), BaseDirectory::Resource)
        .ok()
        .filter(|path| path.is_file())
}

fn spawn_worker(app: &AppHandle, arguments: &[OsString]) -> Result<Child, String> {
    let script = if tauri::is_dev() {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../worker/capture.cjs")
    } else {
        app.path()
            .resolve("capture.cjs", BaseDirectory::Resource)
            .map_err(|error| error.to_string())?
    };
    let packaged = bundled_node(app).is_some();
    for node in node_candidates(app) {
        let mut command = Command::new(node);
        command
            .arg(&script)
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if packaged {
            command.env("SITE_DOWNLOADER_AUTO_INSTALL_BROWSER", "1");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Не удалось запустить Node.js. {error}")),
        }
    }
    Err("Установи Node.js 22+ или укажи путь через SITE_DOWNLOADER_NODE.".into())
}

fn run_capture(
    app: AppHandle,
    request: CaptureRequest,
    events: Channel<Value>,
) -> Result<(), String> {
    if !request.directory.is_absolute() || !request.directory.is_dir() {
        return Err("Выбери существующую папку для сохранения.".into());
    }
    if !(1..=60).contains(&request.wait_seconds) {
        return Err("Укажи время ожидания от 1 до 60 секунд.".into());
    }
    if !(1..=100).contains(&request.page_limit) {
        return Err("Укажи лимит от 1 до 100 страниц.".into());
    }

    let state = app.state::<CaptureState>();
    let mut active = state.0.lock().map_err(|error| error.to_string())?;
    if active.is_some() {
        return Err("Захват уже запущен.".into());
    }
    let options = serde_json::to_string(&request.options).map_err(|error| error.to_string())?;
    let mut child = spawn_worker(
        &app,
        &[
            request.url.into(),
            request.directory.into_os_string(),
            request.wait_seconds.to_string().into(),
            request.page_limit.to_string().into(),
            options.into(),
        ],
    )?;
    let stdout = child.stdout.take().expect("worker stdout is piped");
    *active = Some(child.stdin.take().expect("worker stdin is piped"));
    drop(active);

    let mut result = Err("Процесс захвата завершился без результата.".to_string());
    let mut finished = false;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match event["type"].as_str() {
            Some("complete" | "cancelled") => {
                finished = true;
                result = Ok(());
                let _ = events.send(event);
            }
            Some("error") => {
                finished = true;
                result = Err(event["message"]
                    .as_str()
                    .unwrap_or("Ошибка захвата.")
                    .to_string());
            }
            _ => {
                let _ = events.send(event);
            }
        }
    }

    let exit = child.wait();
    state.0.lock().map_err(|error| error.to_string())?.take();
    if !finished {
        if let Ok(status) = exit {
            return Err(format!("Процесс захвата завершился без результата ({status}). Проверь установку Node.js и Chromium."));
        }
    }
    result
}

#[tauri::command]
async fn start_capture(
    app: AppHandle,
    request: CaptureRequest,
    events: Channel<Value>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_capture(app, request, events))
        .await
        .map_err(|error| error.to_string())?
}

fn send_worker_command(state: &Mutex<Option<ChildStdin>>, command: &[u8]) -> Result<(), String> {
    let mut active = state.lock().map_err(|error| error.to_string())?;
    let stdin = active.as_mut().ok_or("Процесс уже завершился.")?;
    stdin.write_all(command).map_err(|error| error.to_string())
}

#[tauri::command]
fn continue_capture(state: State<'_, CaptureState>) -> Result<(), String> {
    send_worker_command(&state.0, b"continue\n")
}

#[tauri::command]
fn cancel_capture(state: State<'_, CaptureState>) -> Result<(), String> {
    send_worker_command(&state.0, b"cancel\n")
}

fn run_replay(
    app: AppHandle,
    directory: PathBuf,
    events: Channel<Value>,
    use_original_address: bool,
) -> Result<(), String> {
    if !directory.is_absolute() || !directory.join("manifest.json").is_file() {
        return Err("Выбери папку архива, в которой находится manifest.json.".into());
    }
    let state = app.state::<ReplayState>();
    let mut active = state.0.lock().map_err(|error| error.to_string())?;
    if active.is_some() {
        return Err("Интерактивный просмотр уже открыт.".into());
    }
    let address_mode = if use_original_address {
        "original"
    } else {
        "local"
    };
    let mut child = spawn_worker(
        &app,
        &[
            "--replay".into(),
            directory.into_os_string(),
            address_mode.into(),
        ],
    )?;
    let stdout = child.stdout.take().expect("worker stdout is piped");
    *active = Some(child.stdin.take().expect("worker stdin is piped"));
    drop(active);

    let mut outcome = Err("Не удалось запустить интерактивный просмотр.".to_string());
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match event["type"].as_str() {
            Some("complete" | "cancelled") => outcome = Ok(()),
            Some("error") => {
                if let Some(message) = event["message"].as_str() {
                    outcome = Err(message.to_string());
                }
            }
            _ => {
                let _ = events.send(event);
            }
        }
    }
    let exit = child.wait();
    state.0.lock().map_err(|error| error.to_string())?.take();
    exit.map_err(|error| error.to_string())?;
    outcome
}

#[tauri::command]
async fn replay_archive(
    app: AppHandle,
    directory: PathBuf,
    events: Channel<Value>,
    use_original_address: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_replay(app, directory, events, use_original_address)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn stop_replay(state: State<'_, ReplayState>) -> Result<(), String> {
    send_worker_command(&state.0, b"cancel\n")
}

#[tauri::command]
fn inspect_archive(directory: PathBuf) -> Result<ArchiveInfo, String> {
    read_archive_info(directory)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum ArchiveAction {
    LocalHtml,
    Folder,
    SceneAssets,
}

#[tauri::command]
fn open_archive(app: AppHandle, directory: PathBuf, action: ArchiveAction) -> Result<(), String> {
    let archive = read_archive_info(directory)?;
    let path = match action {
        ArchiveAction::LocalHtml => {
            let entry = archive
                .offline_html
                .ok_or("В этом архиве нет локальной HTML-копии.")?;
            archive.folder.join(entry)
        }
        ArchiveAction::SceneAssets if archive.has_scene_assets => archive.folder.join("3d"),
        ArchiveAction::SceneAssets => return Err("В этом архиве нет папки с 3D-файлами.".into()),
        ArchiveAction::Folder => archive.folder,
    };
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("Не удалось открыть архив. {error}"))
}

#[cfg(test)]
mod archive_tests {
    use super::*;

    #[test]
    fn accepts_only_html_paths_inside_the_offline_directory() {
        assert_eq!(
            offline_entry("offline/docs/guide/index.html"),
            Some(PathBuf::from("offline/docs/guide/index.html"))
        );
        assert_eq!(offline_entry("index.html"), None);
        assert_eq!(offline_entry("https://example.com/index.html"), None);
        assert_eq!(offline_entry("offline/../index.html"), None);
        assert_eq!(offline_entry("offline/assets/script.js"), None);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CaptureState::default())
        .manage(ReplayState::default())
        .invoke_handler(tauri::generate_handler![
            start_capture,
            continue_capture,
            cancel_capture,
            replay_archive,
            stop_replay,
            inspect_archive,
            open_archive,
            archive_browser::list_archive_files,
            archive_browser::preview_archive_file,
            archive_browser::reveal_archive_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Site Downloader");
}
