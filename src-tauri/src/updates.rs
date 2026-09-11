use serde::{Deserialize, Serialize};
use std::{io::Read, process::Command, time::Duration};

const RELEASES: &str = "https://github.com/mrueda/digital-genome-workstation/releases";
const API: &str = "https://api.github.com/repos/mrueda/digital-genome-workstation/releases/latest";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    current_version: String,
    latest_version: Option<String>,
    status: &'static str,
    message: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

fn result(current: &str, status: &'static str, message: impl Into<String>) -> UpdateCheck {
    UpdateCheck {
        current_version: current.into(),
        latest_version: None,
        status,
        message: message.into(),
    }
}

fn interpret(current: &str, status: u16, body: &str) -> Result<UpdateCheck, String> {
    match status {
        404 => return Ok(result(current, "unavailable", "No public stable release is available to check. The repository may be private or contain only prereleases. Open GitHub releases and sign in to check test builds.")),
        403 | 429 => return Err("GitHub temporarily refused the check. Please try again later or open releases in your browser.".into()),
        200 => {},
        _ => return Err(format!("GitHub could not complete the check (HTTP {status}). Try again later.")),
    }
    let release: Release = serde_json::from_str(body)
        .map_err(|_| "GitHub returned an unreadable release response.")?;
    let latest = semver::Version::parse(
        release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name),
    )
    .map_err(|_| {
        "The release tag is not a recognizable version. Check GitHub releases manually."
    })?;
    let installed = semver::Version::parse(current)
        .map_err(|_| "The installed version is not recognizable.")?;
    if release.draft || release.prerelease || !latest.pre.is_empty() {
        return Ok(result(
            current,
            "unavailable",
            "This check only compares stable releases. Open GitHub releases for test builds.",
        ));
    }
    let newer = latest.cmp_precedence(&installed).is_gt();
    let mut check = result(
        current,
        if newer { "available" } else { "current" },
        if newer {
            format!("DGW {latest} is available. Open releases to choose the installer for your computer.")
        } else {
            "No newer stable release is available.".into()
        },
    );
    check.latest_version = Some(latest.to_string());
    Ok(check)
}

#[tauri::command]
pub async fn check_app_updates(app: tauri::AppHandle) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!("DGW/{current}"))
            .build()
            .map_err(|_| "Could not start the update check.")?;
        let response = client
            .get(API)
            .header("Accept", "application/vnd.github+json")
            .send()
            .map_err(|_| "Could not reach GitHub. Check your connection and try again.")?;
        let status = response.status().as_u16();
        let mut body = String::new();
        response
            .take(512 * 1024)
            .read_to_string(&mut body)
            .map_err(|_| "Could not read GitHub's response. Try again.")?;
        interpret(&current, status, &body)
    })
    .await
    .map_err(|_| "The update check could not finish.".to_string())?
}

// Fixed destination: never execute a URL or command supplied by a release response.
#[tauri::command]
pub fn open_app_releases() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = Command::new("xdg-open");
    command
        .arg(RELEASES)
        .spawn()
        .map_err(|_| format!("Could not open your browser. Visit {RELEASES}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str) -> String {
        serde_json::json!({"tag_name":tag,"draft":false,"prerelease":false}).to_string()
    }
    #[test]
    fn compares_versions_numerically_and_ignores_build_metadata() {
        for (current, latest, expected) in [
            ("0.9.0", "v0.10.0", "available"),
            ("0.1.0", "v0.1.0", "current"),
            ("0.2.0", "v0.1.0", "current"),
            ("0.1.0+local", "v0.1.0+release", "current"),
            ("0.1.0-preview.1", "v0.1.0", "available"),
        ] {
            assert_eq!(
                interpret(current, 200, &release(latest)).unwrap().status,
                expected
            );
        }
    }
    #[test]
    fn unavailable_or_bad_responses_never_claim_up_to_date() {
        assert_eq!(interpret("0.1.0", 404, "").unwrap().status, "unavailable");
        assert_eq!(
            interpret("0.1.0", 200, &release("v0.2.0-preview.1"))
                .unwrap()
                .status,
            "unavailable"
        );
        for status in [403, 429, 500] {
            assert!(interpret("0.1.0", status, "").is_err());
        }
        assert!(interpret("0.1.0", 200, "{}").is_err());
        assert!(interpret("0.1.0", 200, &release("latest")).is_err());
    }
}
