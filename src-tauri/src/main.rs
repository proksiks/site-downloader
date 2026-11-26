#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    ffi::OsString,
    io::{BufRead, BufReader, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Channel, path::BaseDirectory, AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct CaptureState(Mutex<Option<ChildStdin>>);

#[derive(Default)]
struct ArchiveState(Mutex<Option<ArchivePaths>>);

struct ArchivePaths {
    folder: PathBuf,
    offline_entry: Option<PathBuf>,
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

fn spawn_worker(app: &AppHandle, script: &Path, request: &CaptureRequest) -> Result<Child, String> {
    let options = serde_json::to_string(&request.options).map_err(|error| error.to_string())?;
    for node in node_candidates(app) {
        let mut command = Command::new(node);
        command
            .arg(script)
            .arg(&request.url)
            .arg(&request.directory)
            .arg(request.wait_seconds.to_string())
            .arg(request.page_limit.to_string())
            .arg(&options)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if bundled_node(app).is_some() {
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

    let script = if tauri::is_dev() {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../worker/capture.cjs")
    } else {
        app.path()
            .resolve("capture.cjs", BaseDirectory::Resource)
            .map_err(|error| error.to_string())?
    };
    let state = app.state::<CaptureState>();
    let mut active = state.0.lock().map_err(|error| error.to_string())?;
    if active.is_some() {
        return Err("Захват уже запущен.".into());
    }
    let mut child = spawn_worker(&app, &script, &request)?;
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
            Some("complete") => {
                if let Some(folder) = event["folder"].as_str() {
                    if let Ok(mut archive) = app.state::<ArchiveState>().0.lock() {
                        *archive = Some(ArchivePaths {
                            folder: PathBuf::from(folder),
                            offline_entry: event["offlineEntryFile"]
                                .as_str()
                                .and_then(offline_entry),
                        });
                    }
                }
                finished = true;
                result = Ok(());
                let _ = events.send(event);
            }
            Some("cancelled") => {
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

fn send_worker_command(state: &CaptureState, command: &[u8]) -> Result<(), String> {
    let mut active = state.0.lock().map_err(|error| error.to_string())?;
    let stdin = active.as_mut().ok_or("Захват уже завершился.")?;
    stdin.write_all(command).map_err(|error| error.to_string())
}

#[tauri::command]
fn continue_capture(state: State<'_, CaptureState>) -> Result<(), String> {
    send_worker_command(&state, b"continue\n")
}

#[tauri::command]
fn cancel_capture(state: State<'_, CaptureState>) -> Result<(), String> {
    send_worker_command(&state, b"cancel\n")
}

#[tauri::command]
fn open_archive(
    app: AppHandle,
    state: State<'_, ArchiveState>,
    offline_preview: bool,
) -> Result<(), String> {
    let path = {
        let archive = state.0.lock().map_err(|error| error.to_string())?;
        let archive = archive.as_ref().ok_or("Сначала сохрани архив.")?;
        if offline_preview {
            let entry = archive
                .offline_entry
                .as_ref()
                .ok_or("В этом архиве нет офлайн-страницы.")?;
            archive.folder.join(entry)
        } else {
            archive.folder.clone()
        }
    };
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("Не удалось открыть архив. {error}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CaptureState::default())
        .manage(ArchiveState::default())
        .invoke_handler(tauri::generate_handler![
            start_capture,
            continue_capture,
            cancel_capture,
            open_archive
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Site Downloader");
}
