use crate::{CaptureState, RepairState, ReplayState};
use serde::Serialize;
use std::{process::ChildStdin, sync::Mutex, time::Duration};
use tauri::{
    ipc::Channel,
    utils::{config::BundleType, platform::bundle_type},
    AppHandle, Manager, State,
};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates(Mutex<UpdateState>);

#[derive(Default)]
struct UpdateState {
    available: Option<Update>,
    installing: bool,
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    enabled: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UpdateEvent {
    Downloading { downloaded: u64, total: Option<u64> },
    Installing,
}

#[tauri::command]
pub fn update_info(app: AppHandle) -> UpdateInfo {
    let supported_bundle = matches!(
        bundle_type(),
        Some(BundleType::App | BundleType::Nsis | BundleType::AppImage | BundleType::Deb)
    );
    UpdateInfo {
        version: app.package_info().version.to_string(),
        enabled: supported_bundle && app.config().plugins.0.contains_key("updater"),
    }
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    updates: State<'_, Updates>,
) -> Result<Option<String>, String> {
    if !update_info(app.clone()).enabled {
        return Err("В этой сборке автообновление недоступно.".into());
    }
    let available = app
        .updater_builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| format!("Не удалось проверить обновления. {error}"))?;
    if available
        .as_ref()
        .is_some_and(|update| update.download_url.scheme() != "https")
    {
        return Err("Обновление должно загружаться по HTTPS.".into());
    }
    let version = available.as_ref().map(|update| update.version.clone());
    let mut state = updates.0.lock().map_err(|error| error.to_string())?;
    if !state.installing {
        state.available = available;
    }
    Ok(version)
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    updates: State<'_, Updates>,
    version: String,
    events: Channel<UpdateEvent>,
) -> Result<(), String> {
    let worker_running =
        |state: &Mutex<Option<ChildStdin>>| state.lock().map_or(true, |value| value.is_some());
    if worker_running(&app.state::<CaptureState>().0)
        || worker_running(&app.state::<ReplayState>().0)
        || worker_running(&app.state::<RepairState>().0)
    {
        return Err("Перед обновлением заверши захват, докачку или просмотр архива.".into());
    }

    let update = {
        let mut state = updates.0.lock().map_err(|error| error.to_string())?;
        if state.installing {
            return Err("Обновление уже устанавливается.".into());
        }
        let update = state
            .available
            .as_ref()
            .filter(|update| update.version == version)
            .cloned()
            .ok_or("Проверь наличие обновлений ещё раз.")?;
        state.installing = true;
        update
    };
    let result = download_and_install(update, events).await;
    if result.is_ok() {
        app.request_restart();
    } else {
        updates
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .installing = false;
    }
    result
}

async fn download_and_install(
    mut update: Update,
    events: Channel<UpdateEvent>,
) -> Result<(), String> {
    update.timeout = Some(Duration::from_secs(15 * 60));
    let mut downloaded = 0;
    let mut reported = 0;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if reported == 0 || downloaded - reported >= 256 * 1024 || total == Some(downloaded)
                {
                    reported = downloaded;
                    let _ = events.send(UpdateEvent::Downloading { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|error| format!("Не удалось загрузить или проверить обновление. {error}"))?;

    let _ = events.send(UpdateEvent::Installing);
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("Не удалось установить обновление. {error}"))
}
