use crate::{error_text, AppState};
use dgw_mcp::{
    desktop::{self, AccessStatus, ConnectionSettings, DesktopGrant},
    DgwMcpServer,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
};
use tauri::Emitter;

#[derive(Default)]
pub struct AgentAccess {
    grant: Mutex<Option<DesktopGrant>>,
    generation: AtomicU64,
    project: Mutex<Option<PathBuf>>,
    context: Arc<RwLock<Value>>,
}

#[tauri::command]
pub fn agent_project(
    state: tauri::State<'_, AgentAccess>,
    project_path: Option<PathBuf>,
) -> Result<(), String> {
    let path = project_path
        .map(std::fs::canonicalize)
        .transpose()
        .map_err(error_text)?;
    let mut project = state.project.lock().map_err(error_text)?;
    if *project != path {
        state.generation.fetch_add(1, Ordering::SeqCst);
        state.grant.lock().map_err(error_text)?.take();
        *project = path.clone();
        *state.context.write().map_err(error_text)? =
            json!({"projectPath": path, "workspace": null});
    }
    Ok(())
}

#[tauri::command]
pub fn agent_context(
    state: tauri::State<'_, AgentAccess>,
    project_path: PathBuf,
    context: Value,
) -> Result<(), String> {
    if context.to_string().len() > 512 * 1024 {
        return Err("Agent context is too large".into());
    }
    let path = std::fs::canonicalize(project_path).map_err(error_text)?;
    let project = state.project.lock().map_err(error_text)?;
    if project.as_ref() != Some(&path) {
        return Err("Project changed".into());
    }
    *state.context.write().map_err(error_text)? =
        json!({"projectPath": path, "workspace": context});
    Ok(())
}

#[tauri::command]
pub fn agent_status(state: tauri::State<'_, AgentAccess>) -> Result<AccessStatus, String> {
    Ok(state
        .grant
        .lock()
        .map_err(error_text)?
        .as_ref()
        .map(|g| g.status())
        .unwrap_or(AccessStatus {
            enabled: false,
            allow_edits: false,
            expires_at: None,
        }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnection {
    command: PathBuf,
    args: Vec<String>,
    #[serde(flatten)]
    settings: ConnectionSettings,
}

#[tauri::command]
pub async fn enable_agent_access(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentAccess>,
    core: tauri::State<'_, AppState>,
    allow_edits: bool,
) -> Result<AgentConnection, String> {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let path = state
        .project
        .lock()
        .map_err(error_text)?
        .clone()
        .ok_or("Open a project before enabling agent access")?;
    let project_id = dgw_core::Project::open(&path)
        .map_err(error_text)?
        .manifest()
        .project_id
        .clone();
    let command = std::env::current_exe().map_err(error_text)?;
    let event_path = path.clone();
    let notify: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        let _ = app.emit(
            "dgw-agent-change",
            json!({"projectPath": event_path, "projectId": project_id}),
        );
    });
    let server = DgwMcpServer::for_desktop(
        path.clone(),
        core.evaluation.clone(),
        core.compute_pool.clone(),
        core.job_lock.clone(),
        notify.clone(),
    );
    let (grant, settings) =
        desktop::start(server, state.context.clone(), allow_edits, notify).await?;
    let project = state.project.lock().map_err(error_text)?;
    let mut access = state.grant.lock().map_err(error_text)?;
    if project.as_ref() != Some(&path) || state.generation.load(Ordering::SeqCst) != generation {
        return Err("Project or access changed; enable access again".into());
    }
    *access = Some(grant);
    Ok(AgentConnection {
        command,
        args: vec!["--mcp-connect".into()],
        settings,
    })
}

#[tauri::command]
pub fn disable_agent_access(state: tauri::State<'_, AgentAccess>) -> Result<(), String> {
    let mut access = state.grant.lock().map_err(error_text)?;
    state.generation.fetch_add(1, Ordering::SeqCst);
    access.take();
    Ok(())
}
