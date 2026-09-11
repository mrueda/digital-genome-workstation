//! Graphical, non-elevated installation for portable Linux/macOS application bundles.
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{ipc::Channel, Manager};

pub struct UserSetup {
    pub source: PathBuf,
    pub installed: Mutex<Option<PathBuf>>,
}

pub fn source() -> Option<PathBuf> {
    if std::env::args().any(|arg| arg == "--dgw-run") {
        return None;
    }
    #[cfg(target_os = "linux")]
    let source = if let Some(path) = std::env::var_os("APPIMAGE") {
        PathBuf::from(path).canonicalize().ok()?
    } else {
        std::env::current_exe()
            .ok()?
            .ancestors()
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "AppDir")
            })?
            .to_owned()
    };
    #[cfg(target_os = "macos")]
    let source = std::env::current_exe()
        .ok()?
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))?
        .to_owned();
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    return None;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        if !source.exists() {
            return None;
        }
        let marker = source.parent()?.join(".dgw-installed.json");
        if fs::read_to_string(marker)
            .ok()
            .and_then(|s| serde_json::from_str::<PathBuf>(&s).ok())
            .as_ref()
            == Some(&source)
        {
            return None;
        }
        #[cfg(target_os = "macos")]
        if source
            .parent()
            .is_some_and(|p| p == Path::new("/Applications"))
        {
            return None;
        }
        Some(source)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupInfo {
    platform: &'static str,
    version: &'static str,
    suggested_parent: PathBuf,
}

#[tauri::command]
pub fn user_setup_info(app: tauri::AppHandle) -> Result<SetupInfo, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(SetupInfo {
        platform: std::env::consts::OS,
        version: env!("CARGO_PKG_VERSION"),
        suggested_parent: if cfg!(target_os = "macos") {
            home.join("Applications")
        } else {
            home.join(".local/opt")
        },
    })
}

fn safe_text(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("Choose a UTF-8 installation path")?;
    if text.chars().any(|c| c.is_control()) {
        return Err("Installation path contains control characters".into());
    }
    Ok(text.to_owned())
}

fn desktop_entry(binary: &Path, icon: &Path) -> Result<String, String> {
    let quoted = safe_text(binary)?
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('%', "%%");
    let icon = safe_text(icon)?.replace('\\', "\\\\");
    Ok(format!("[Desktop Entry]\nType=Application\nName=Digital Genome Workstation\nExec=\"{quoted}\" --dgw-run\nIcon={icon}\nTerminal=false\nCategories=Education;Science;\n"))
}

fn publish_copy(source: &Path, target: &Path) -> Result<(), String> {
    let mut stage =
        tempfile::NamedTempFile::new_in(target.parent().ok_or("Missing destination parent")?)
            .map_err(|e| e.to_string())?;
    let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
    std::io::copy(&mut input, &mut stage).map_err(|e| e.to_string())?;
    stage.as_file().sync_all().map_err(|e| e.to_string())?;
    fs::set_permissions(
        stage.path(),
        fs::metadata(source)
            .map_err(|e| e.to_string())?
            .permissions(),
    )
    .map_err(|e| e.to_string())?;
    stage
        .persist_noclobber(target)
        .map_err(|e| format!("Could not install without overwriting files: {e}"))?;
    Ok(())
}

#[cfg(unix)]
fn copy_portable_tree(root: &Path, source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let destination = target.join(entry.file_name());
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            let link = fs::read_link(&path).map_err(|e| e.to_string())?;
            let resolved = path.canonicalize().map_err(|e| e.to_string())?;
            if link.is_absolute() || !resolved.starts_with(root) {
                return Err("Portable application contains an external symbolic link".into());
            }
            std::os::unix::fs::symlink(link, destination).map_err(|e| e.to_string())?;
        } else if kind.is_dir() {
            copy_portable_tree(root, &path, &destination)?;
        } else if kind.is_file() {
            publish_copy(&path, &destination)?;
        } else {
            return Err("Portable application contains an unsupported file type".into());
        }
    }
    fs::set_permissions(
        target,
        fs::metadata(source)
            .map_err(|e| e.to_string())?
            .permissions(),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
fn install(
    source: &Path,
    parent: &Path,
    applications: &Path,
    progress: impl Fn(&str),
) -> Result<PathBuf, String> {
    install_with_replace(source, parent, applications, false, progress)
}

fn install_with_replace(
    source: &Path,
    parent: &Path,
    applications: &Path,
    replace: bool,
    progress: impl Fn(&str),
) -> Result<PathBuf, String> {
    safe_text(parent)?;
    if !parent.is_absolute() {
        return Err("Choose an absolute installation folder".into());
    }
    fs::create_dir_all(parent)
        .map_err(|e| format!("Cannot write to this folder; choose one you own: {e}"))?;
    let parent = parent.canonicalize().map_err(|e| e.to_string())?;
    // Versioned folder avoids replacing an app or deleting somebody's files.
    let destination = parent.join(format!("DGW-{}", env!("CARGO_PKG_VERSION")));
    let stage = tempfile::tempdir_in(&parent).map_err(|e| e.to_string())?;
    if destination.symlink_metadata().is_ok() {
        if !replace {
            return Err("DGW is already installed here. Enable Replace existing installation to update it.".into());
        }
        let known = fs::read(destination.join(".dgw-installed.json"))
            .ok().and_then(|bytes| serde_json::from_slice::<PathBuf>(&bytes).ok());
        if destination.is_symlink() || !known.is_some_and(|path| path.parent() == Some(destination.as_path())) {
            return Err("This folder is not a recognized DGW installation. Choose another folder; its files have not been changed.".into());
        }
    }
    let mac = cfg!(target_os = "macos");
    let portable_directory = !mac && source.is_dir();
    let name = if mac {
        "Digital Genome Workstation.app"
    } else if portable_directory {
        "DGW.AppDir"
    } else {
        "DGW.AppImage"
    };
    let final_app = destination.join(name);
    let executable = if portable_directory {
        final_app.join("AppRun")
    } else {
        final_app.clone()
    };
    let launcher = applications.join(format!(
        "org.mrueda.dgw-{}.desktop",
        env!("CARGO_PKG_VERSION")
    ));
    if !mac && launcher.symlink_metadata().is_ok() && !replace {
        return Err(
            "A DGW shortcut already exists. Enable Replace existing installation to update the shortcut too."
                .into(),
        );
    }
    progress("Copying the application…");
    if mac {
        let result = Command::new("/usr/bin/ditto")
            .args(["--rsrc", "--extattr"])
            .arg(source)
            .arg(stage.path().join(name))
            .output()
            .map_err(|e| e.to_string())?;
        if !result.status.success() {
            return Err(format!(
                "Application copy failed: {}",
                String::from_utf8_lossy(&result.stderr)
            ));
        }
    } else {
        if portable_directory {
            #[cfg(unix)]
            copy_portable_tree(
                &source.canonicalize().map_err(|e| e.to_string())?,
                source,
                &stage.path().join(name),
            )?;
            #[cfg(not(unix))]
            return Err("Portable directory setup is only supported on Unix".into());
        } else {
            publish_copy(source, &stage.path().join(name))?;
        }
        fs::write(
            stage.path().join("dgw.svg"),
            include_bytes!("../../brand/dgw-mark.svg"),
        )
        .map_err(|e| e.to_string())?;
    }
    fs::write(
        stage.path().join(".dgw-installed.json"),
        serde_json::to_vec(&final_app).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // Keep recoverable copies; never delete the previous installation or shortcut.
    let backup = if replace && (destination.exists() || (!mac && launcher.symlink_metadata().is_ok())) {
        let folder = tempfile::Builder::new().prefix("dgw-backup-").tempdir_in(&parent)
            .map_err(|e| e.to_string())?.keep();
        if !mac && launcher.symlink_metadata().is_ok() {
            if !launcher.is_file() || launcher.is_symlink() {
                return Err("The existing shortcut is not a regular file; it has not been changed.".into());
            }
            fs::copy(&launcher, folder.join("launcher.desktop.backup")).map_err(|e| e.to_string())?;
        }
        if destination.exists() {
            fs::rename(&destination, folder.join("application")).map_err(|e| e.to_string())?;
        }
        progress(&format!("Previous installation saved in {}", folder.display()));
        Some(folder)
    } else { None };
    // Reserve the final directory atomically. Only our own empty reservation is used.
    fs::create_dir(&destination).map_err(|e| format!("Cannot create installation folder: {e}"))?;
    if let Err(error) = fs::rename(stage.path(), &destination) {
        let _ = fs::remove_dir(&destination);
        if let Some(folder) = &backup {
            if folder.join("application").exists() {
                let _ = fs::rename(folder.join("application"), &destination);
            }
        }
        return Err(format!("Could not publish application: {error}"));
    }
    if !mac {
        progress("Adding the application-menu shortcut…");
        let result = (|| {
            fs::create_dir_all(applications).map_err(|e| e.to_string())?;
            let mut file =
                tempfile::NamedTempFile::new_in(applications).map_err(|e| e.to_string())?;
            use std::io::Write;
            file.write_all(desktop_entry(&executable, &destination.join("dgw.svg"))?.as_bytes())
                .map_err(|e| e.to_string())?;
            if replace {
                file.persist(&launcher).map_err(|e| e.to_string())?;
            } else {
                file.persist_noclobber(&launcher).map_err(|e| e.to_string())?;
            }
            Ok::<_, String>(())
        })();
        if let Err(error) = result {
            return Err(format!("DGW was copied to {}, but its menu shortcut could not be added: {error}. You can open the installed application there.", final_app.display()));
        }
    }
    progress("Installation complete. Genome resources are configured inside DGW.");
    Ok(executable)
}

#[tauri::command]
pub async fn install_for_user(
    app: tauri::AppHandle,
    state: tauri::State<'_, UserSetup>,
    parent: PathBuf,
    replace_existing: bool,
    on_progress: Channel<String>,
) -> Result<PathBuf, String> {
    if state.installed.lock().map_err(|e| e.to_string())?.is_some() {
        return Err("This setup has already installed DGW".into());
    }
    let source = state.source.clone();
    let applications = app
        .path()
        .data_dir()
        .map_err(|e| e.to_string())?
        .join("applications");
    let installed = tauri::async_runtime::spawn_blocking(move || {
        install_with_replace(&source, &parent, &applications, replace_existing, |message| {
            let _ = on_progress.send(message.to_owned());
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    *state.installed.lock().map_err(|e| e.to_string())? = Some(installed.clone());
    Ok(installed)
}

#[tauri::command]
pub async fn launch_user_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, UserSetup>,
) -> Result<(), String> {
    let path = state
        .installed
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Install DGW first")?;
    let log_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
        let log_path = log_dir.join("setup-launch.log");
        let log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
        let mut command = if cfg!(target_os = "macos") {
            let mut cmd = Command::new("/usr/bin/open");
            cmd.arg(&path).args(["--args", "--dgw-run"]);
            cmd
        } else {
            let mut cmd = Command::new(&path);
            cmd.arg("--dgw-run").env_remove("APPIMAGE").env_remove("APPDIR");
            cmd
        };
        let mut child = command.stdin(std::process::Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log)
            .spawn().map_err(|e| format!("DGW could not start: {e}"))?;
        for _ in 0..30 {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                if cfg!(target_os = "macos") && status.success() { return Ok(()); }
                return Err(format!("DGW closed during startup ({status}). Details: {}", log_path.display()));
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

pub fn run(source: PathBuf) {
    let mut context = tauri::generate_context!();
    let window = &mut context.config_mut().app.windows[0];
    window.url = tauri::WebviewUrl::App("index.html?setup".into());
    window.title = "DGW Setup".into();
    window.width = 740.0;
    window.height = 640.0;
    window.min_width = Some(620.0);
    window.min_height = Some(540.0);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(UserSetup {
            source,
            installed: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            user_setup_info,
            install_for_user,
            launch_user_install
        ])
        .run(context)
        .expect("could not start DGW Setup");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launcher_quotes_spaces_and_rejects_newline_injection() {
        let entry = desktop_entry(
            Path::new("/tmp/my apps/$DGW%/app"),
            Path::new("/tmp/icon.svg"),
        )
        .unwrap();
        assert!(entry.contains("Exec=\"/tmp/my apps/\\$DGW%%/app\" --dgw-run"));
        assert!(desktop_entry(Path::new("/tmp/app\nExec=bad"), Path::new("/tmp/i")).is_err());
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn user_install_copies_and_refuses_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("download.AppImage");
        fs::write(&source, b"test payload").unwrap();
        let parent = tmp.path().join("my apps");
        let apps = tmp.path().join("menu");
        let target = install(&source, &parent, &apps, |_| {}).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"test payload");
        assert!(apps.join("org.mrueda.dgw-0.1.0.desktop").is_file());
        assert!(install(&source, &parent, &apps, |_| {}).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"test payload");
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn replacement_preserves_backup_and_updates_stale_shortcut() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("download.AppImage");
        let parent = tmp.path().join("apps");
        let menu = tmp.path().join("menu");
        fs::write(&source, b"old").unwrap();
        let target = install(&source, &parent, &menu, |_| {}).unwrap();
        fs::write(&source, b"new").unwrap();
        install_with_replace(&source, &parent, &menu, true, |_| {}).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        let backup = fs::read_dir(&parent).unwrap().flatten().find(|entry| entry.file_name().to_string_lossy().starts_with("dgw-backup-")).unwrap().path();
        assert_eq!(fs::read(backup.join("application/DGW.AppImage")).unwrap(), b"old");
        assert!(backup.join("launcher.desktop.backup").is_file());
        let other = tmp.path().join("another install");
        install_with_replace(&source, &other, &menu, true, |_| {}).unwrap();
        assert!(fs::read_to_string(menu.join("org.mrueda.dgw-0.1.0.desktop")).unwrap().contains("another install"));
        let unknown = tmp.path().join("unknown");
        fs::create_dir_all(unknown.join("DGW-0.1.0")).unwrap();
        fs::write(unknown.join("DGW-0.1.0/important"), b"keep").unwrap();
        assert!(install_with_replace(&source, &unknown, &menu, true, |_| {}).is_err());
        assert_eq!(fs::read(unknown.join("DGW-0.1.0/important")).unwrap(), b"keep");
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn directory_install_preserves_links_and_rejects_external_links() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("Setup.AppDir");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("AppRun"), b"test launcher").unwrap();
        std::os::unix::fs::symlink("AppRun", source.join("link")).unwrap();
        let target = install(
            &source,
            &tmp.path().join("apps"),
            &tmp.path().join("menu"),
            |_| {},
        )
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"test launcher");
        assert_eq!(
            fs::read_link(target.parent().unwrap().join("link")).unwrap(),
            Path::new("AppRun")
        );
        std::os::unix::fs::symlink("../../outside", source.join("escape")).unwrap();
        assert!(install(
            &source,
            &tmp.path().join("other apps"),
            &tmp.path().join("other menu"),
            |_| {}
        )
        .is_err());
    }
}
