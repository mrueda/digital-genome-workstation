use dgw_core::{
    resources::resolve_bundle_paths, validate_resource_bundle, ConsequenceAnnotationResource,
    FileFingerprint, GeneAnnotationResource, IndexedResource, ResourceBundle,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::{ipc::Channel, Manager};

pub struct ResourceInstaller(pub Mutex<()>);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceFile {
    path: PathBuf,
    url: String,
    sha256: String,
    bytes: u64,
    #[serde(default)]
    executable: bool,
    #[serde(default)]
    archive_root: Option<String>,
    #[serde(default)]
    unpacked_bytes: u64,
    #[serde(default)]
    manifest_sha256: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRelease {
    id: String,
    name: String,
    version: String,
    assembly: String,
    platform: String,
    files: Vec<ResourceFile>,
    bundle: ResourceBundle,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    releases: Vec<ResourceRelease>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceArtifact {
    id: String,
    kind: String,
    file: PathBuf,
    bytes: u64,
    sha256: String,
    manifest_sha256: String,
    unpacked_bytes: u64,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    assembly: Option<String>,
    #[serde(default)]
    contig_style: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactCatalog {
    schema_version: u32,
    artifacts: Vec<ResourceArtifact>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    directory: Option<PathBuf>,
    #[serde(default)]
    registered: Vec<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledResource {
    pub bundle: ResourceBundle,
    descriptor: PathBuf,
    ready: bool,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInventory {
    directory: PathBuf,
    platform: String,
    releases: Vec<ResourceRelease>,
    installed: Vec<InstalledResource>,
    issues: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    stage: String,
    message: String,
    completed_bytes: u64,
    total_bytes: u64,
}

fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("resources.json"))
}
fn preferences(app: &tauri::AppHandle) -> Result<Preferences, String> {
    let path = preferences_path(app)?;
    if !path.exists() {
        return Ok(Preferences::default());
    }
    serde_json::from_reader(File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn save_preferences(app: &tauri::AppHandle, settings: &Preferences) -> Result<(), String> {
    let path = preferences_path(app)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, settings).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn directory(app: &tauri::AppHandle, settings: &Preferences) -> Result<PathBuf, String> {
    Ok(settings.directory.clone().unwrap_or(
        app.path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("resources"),
    ))
}
fn read_bundle(path: &Path) -> Result<ResourceBundle, String> {
    let bundle = serde_json::from_reader(File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    resolve_bundle_paths(
        bundle,
        path.parent()
            .ok_or("Resource descriptor has no directory")?,
    )
    .map_err(|e| e.to_string())
}
pub fn registered_bundles(app: &tauri::AppHandle) -> Result<Vec<ResourceBundle>, String> {
    Ok(preferences(app)?
        .registered
        .iter()
        .rev()
        .filter_map(|path| read_bundle(path).ok())
        .collect())
}
fn catalog() -> Result<Catalog, String> {
    let catalog: Catalog = serde_json::from_str(include_str!("../../config/resource-catalog.json"))
        .map_err(|e| e.to_string())?;
    if catalog.schema_version != 1 {
        return Err("Unsupported resource catalog".into());
    }
    Ok(catalog)
}

fn artifact_catalog() -> Result<ArtifactCatalog, String> {
    let catalog: ArtifactCatalog =
        serde_json::from_str(include_str!("../../config/resource-artifacts.json"))
            .map_err(|e| e.to_string())?;
    if catalog.schema_version != 1 {
        return Err("Unsupported resource artifact catalog".into());
    }
    Ok(catalog)
}

fn platform_id() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

#[tauri::command]
pub async fn resource_inventory(app: tauri::AppHandle) -> Result<ResourceInventory, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = preferences(&app)?;
        let mut installed = Vec::new();
        let mut issues = Vec::new();
        for path in &settings.registered {
            // An unavailable registration must remain visible so it can be repaired.
            match read_bundle(path) {
                Ok(bundle) => {
                    let checked = validate_resource_bundle(&bundle);
                    installed.push(InstalledResource {
                        bundle,
                        descriptor: path.clone(),
                        ready: checked.is_ok(),
                        message: match checked {
                            Ok(warnings) if warnings.is_empty() => "Ready".into(),
                            Ok(warnings) => warnings.join("; "),
                            Err(error) => error.to_string(),
                        },
                    });
                }
                Err(error) => issues.push(format!("Cannot read {}: {error}", path.display())),
            }
        }
        Ok(ResourceInventory {
            directory: directory(&app, &settings)?,
            platform: platform_id(),
            releases: catalog()?.releases,
            installed,
            issues,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn set_resource_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, ResourceInstaller>,
    path: PathBuf,
) -> Result<(), String> {
    let _lock = state
        .0
        .try_lock()
        .map_err(|_| "An installation is already running")?;
    if !path.is_absolute() || !path.is_dir() {
        return Err("Choose an existing resource folder".into());
    }
    let mut settings = preferences(&app)?;
    settings.directory = Some(path.canonicalize().map_err(|e| e.to_string())?);
    save_preferences(&app, &settings)
}

#[tauri::command]
pub async fn register_resource_bundle(app: tauri::AppHandle, path: PathBuf) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ResourceInstaller>();
        let _lock = state
            .0
            .try_lock()
            .map_err(|_| "An installation is already running")?;
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let bundle = read_bundle(&path)?;
        validate_resource_bundle(&bundle).map_err(|e| e.to_string())?;
        let mut settings = preferences(&app)?;
        if !settings.registered.contains(&path) {
            settings.registered.push(path);
        }
        save_preferences(&app, &settings)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}
fn file_matches(path: &Path, expected: &ResourceFile) -> Result<bool, String> {
    file_matches_values(path, expected.bytes, &expected.sha256)
}
fn file_matches_values(path: &Path, bytes: u64, sha256: &str) -> Result<bool, String> {
    if !path.is_file() {
        return Ok(false);
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != bytes {
        return Ok(false);
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()) == sha256.to_lowercase())
}

fn selected_artifact(path: &Path, catalog: &ArtifactCatalog) -> Result<ResourceArtifact, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Selected package has an invalid file name")?;
    let artifact = catalog
        .artifacts
        .iter()
        .find(|artifact| artifact.file.file_name().and_then(|value| value.to_str()) == Some(name))
        .cloned()
        .ok_or_else(|| format!("{name} is not a recognized DGW release package"))?;
    if !file_matches_values(path, artifact.bytes, &artifact.sha256)? {
        return Err(format!("Checksum verification failed for {name}"));
    }
    Ok(artifact)
}

fn manifest_file<'a>(
    manifest: &'a crate::resource_archive::ArchiveManifest,
    role: &str,
) -> Result<&'a crate::resource_archive::ManifestFile, String> {
    manifest
        .files
        .iter()
        .find(|file| file.role.as_deref() == Some(role))
        .ok_or_else(|| format!("Data package does not define {role}"))
}

fn release_text(file: &crate::resource_archive::ManifestFile) -> String {
    file.release
        .clone()
        .unwrap_or_else(|| "Unspecified release".into())
}

fn license_text(file: &crate::resource_archive::ManifestFile) -> String {
    file.license_label
        .clone()
        .unwrap_or_else(|| "See package manifest".into())
}

fn bundle_from_archives(
    data: &ResourceArtifact,
    tools: &ResourceArtifact,
    data_manifest: &crate::resource_archive::ArchiveManifest,
) -> Result<ResourceBundle, String> {
    let assembly = data
        .assembly
        .clone()
        .or_else(|| data_manifest.assembly.clone())
        .ok_or("Data package does not declare an assembly")?;
    let contig_style = data
        .contig_style
        .clone()
        .ok_or("Data package does not declare a contig style")?;
    let genes = manifest_file(data_manifest, "genes")?;
    let consequence = manifest_file(data_manifest, "consequences")?;
    let clinvar = manifest_file(data_manifest, "clinvar")?;
    let data_root = PathBuf::from(&data.id);
    let tool_root = PathBuf::from(&tools.id);
    let tool = |name: &str| {
        tool_root.join("bin").join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        })
    };
    let data_path = |path: &str| data_root.join(path);
    let gene_path = data_path("genes/genes.gtf.gz");
    let consequence_path = data_path("consequence/transcripts.gff3.gz");
    let annotation_assembly = if assembly == "b37" {
        "GRCh37"
    } else {
        "GRCh38"
    };
    Ok(ResourceBundle {
        schema_version: 1,
        id: format!("{}--{}", data.id, tools.id),
        assembly,
        contig_style,
        reference_path: data_path("reference/genome.fa.gz"),
        reference_fai_path: data_path("reference/genome.fa.gz.fai"),
        reference_gzi_path: Some(data_path("reference/genome.fa.gz.gzi")),
        bcftools_path: tool("bcftools"),
        bcftools_version: "1.24".into(),
        bgzip_path: tool("bgzip"),
        tabix_path: tool("tabix"),
        clinvar: IndexedResource {
            path: data_path("evidence/clinvar.vcf.gz"),
            index_path: data_path("evidence/clinvar.vcf.gz.tbi"),
            release: release_text(clinvar),
            license_label: license_text(clinvar),
            contig_style: Some("no_chr_prefix".into()),
            fingerprint: Some(FileFingerprint {
                path: data_path("evidence/clinvar.vcf.gz"),
                sha256: clinvar.sha256.clone(),
                size: clinvar.bytes,
                modified_unix: None,
            }),
        },
        cosmic: IndexedResource {
            path: PathBuf::new(),
            index_path: PathBuf::new(),
            release: "Not configured".into(),
            license_label: "User-supplied; not redistributed".into(),
            contig_style: Some("no_chr_prefix".into()),
            fingerprint: None,
        },
        gene_annotation: Some(GeneAnnotationResource {
            path: gene_path.clone(),
            index_path: data_path("genes/genes.sqlite"),
            assembly: annotation_assembly.into(),
            contig_style: "no_chr_prefix".into(),
            release: release_text(genes),
            source_url: genes.source_url.clone().unwrap_or_default(),
            license_label: license_text(genes),
            fingerprint: Some(FileFingerprint {
                path: gene_path,
                sha256: genes.sha256.clone(),
                size: genes.bytes,
                modified_unix: None,
            }),
        }),
        consequence_annotation: Some(ConsequenceAnnotationResource {
            path: consequence_path.clone(),
            assembly: annotation_assembly.into(),
            contig_style: "no_chr_prefix".into(),
            release: release_text(consequence),
            source_url: consequence.source_url.clone().unwrap_or_default(),
            license_label: license_text(consequence),
            fingerprint: Some(FileFingerprint {
                path: consequence_path,
                sha256: consequence.sha256.clone(),
                size: consequence.bytes,
                modified_unix: None,
            }),
        }),
        bundle_fingerprint: None,
    })
}

#[tauri::command]
pub async fn install_downloaded_packages(
    app: tauri::AppHandle,
    paths: Vec<PathBuf>,
    on_progress: Channel<InstallProgress>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ResourceInstaller>();
        let _lock = state
            .0
            .try_lock()
            .map_err(|_| "An installation is already running")?;
        if paths.len() != 2 {
            return Err("Choose one DGW data package and one DGW tool package".into());
        }
        let paths = paths
            .into_iter()
            .map(|path| path.canonicalize().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let catalog = artifact_catalog()?;
        let total = paths
            .iter()
            .filter_map(|path| path.metadata().ok().map(|metadata| metadata.len()))
            .sum();
        let report = |stage: &str, message: String, completed_bytes| {
            let _ = on_progress.send(InstallProgress {
                stage: stage.into(),
                message,
                completed_bytes,
                total_bytes: total,
            });
        };
        report("verify", "Verifying selected release packages".into(), 0);
        let selected = paths
            .iter()
            .map(|path| selected_artifact(path, &catalog).map(|artifact| (path, artifact)))
            .collect::<Result<Vec<_>, _>>()?;
        let (data_path, data) = selected
            .iter()
            .find(|(_, artifact)| artifact.kind == "data")
            .ok_or("Choose one DGW data package")?;
        let (tool_path, tools) = selected
            .iter()
            .find(|(_, artifact)| artifact.kind == "tools")
            .ok_or("Choose one DGW tool package")?;
        if selected
            .iter()
            .filter(|(_, artifact)| artifact.kind == "data")
            .count()
            != 1
            || selected
                .iter()
                .filter(|(_, artifact)| artifact.kind == "tools")
                .count()
                != 1
        {
            return Err("Choose exactly one data package and one tool package".into());
        }
        if tools.platform.as_deref() != Some(platform_id().as_str()) {
            return Err("The selected tool package does not support this computer".into());
        }
        let mut settings = preferences(&app)?;
        let base = directory(&app, &settings)?;
        fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let release_id = format!("{}--{}", data.id, tools.id);
        let root = base.join(&release_id);
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        report("extract", format!("Installing {}", tools.id), 0);
        crate::resource_archive::install(
            tool_path,
            &root,
            &tools.id,
            tools.unpacked_bytes,
            Some(&tools.manifest_sha256),
        )?;
        report("extract", format!("Installing {}", data.id), tools.bytes);
        let data_manifest = crate::resource_archive::install(
            data_path,
            &root,
            &data.id,
            data.unpacked_bytes,
            Some(&data.manifest_sha256),
        )?;
        report(
            "configure",
            "Checking the installed resources".into(),
            total,
        );
        let portable = bundle_from_archives(data, tools, &data_manifest)?;
        let resolved = resolve_bundle_paths(portable.clone(), &root).map_err(|e| e.to_string())?;
        validate_resource_bundle(&resolved).map_err(|e| e.to_string())?;
        let descriptor = root.join("dgw-bundle.json");
        if descriptor.exists() {
            let existing: ResourceBundle =
                serde_json::from_reader(File::open(&descriptor).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if existing != portable {
                return Err("Existing DGW bundle descriptor differs".into());
            }
        } else {
            let mut output = tempfile::NamedTempFile::new_in(&root).map_err(|e| e.to_string())?;
            serde_json::to_writer_pretty(&mut output, &portable).map_err(|e| e.to_string())?;
            output.as_file().sync_all().map_err(|e| e.to_string())?;
            output
                .persist_noclobber(&descriptor)
                .map_err(|e| e.to_string())?;
        }
        let descriptor = descriptor.canonicalize().map_err(|e| e.to_string())?;
        if !settings.registered.contains(&descriptor) {
            settings.registered.push(descriptor);
        }
        save_preferences(&app, &settings)?;
        report("complete", "Resources are ready".into(), total);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_resource_release(
    app: tauri::AppHandle,
    release_id: String,
    on_progress: Channel<InstallProgress>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ResourceInstaller>();
        let _lock = state
            .0
            .try_lock()
            .map_err(|_| "An installation is already running")?;
        let release = catalog()?
            .releases
            .into_iter()
            .find(|entry| entry.id == release_id)
            .ok_or("This resource release is not published yet")?;
        let platform = platform_id();
        if release.platform != platform {
            return Err("This resource release does not support this computer".into());
        }
        if !safe_relative(Path::new(&release.id))
            || release.id.contains('/')
            || release.id.contains('\\')
        {
            return Err("Invalid resource release ID".into());
        }
        let mut settings = preferences(&app)?;
        let root = directory(&app, &settings)?.join(&release.id);
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        let total: u64 = release.files.iter().map(|file| file.bytes).sum();
        let mut completed = 0;
        let report = |stage: &str, message: String, completed_bytes| {
            let _ = on_progress.send(InstallProgress {
                stage: stage.into(),
                message,
                completed_bytes,
                total_bytes: total,
            });
        };
        let client = reqwest::blocking::Client::builder()
            .https_only(true)
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        for entry in &release.files {
            if !safe_relative(&entry.path)
                || entry.sha256.len() != 64
                || !entry.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err("Invalid resource file descriptor".into());
            }
            let destination = root.join(&entry.path);
            if let Some(name) = &entry.archive_root {
                let manifest_sha256 = entry
                    .manifest_sha256
                    .as_deref()
                    .ok_or("Resource archive does not declare its manifest checksum")?;
                let extracted = root.join(name);
                if extracted.exists() {
                    report("verify", format!("Checking installed {name}"), completed);
                    crate::resource_archive::verify_installed(&extracted, name, manifest_sha256)?;
                    completed += entry.bytes;
                    continue;
                }
            }
            fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
            if !destination
                .parent()
                .unwrap()
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(&root)
            {
                return Err("Resource destination escapes its installation directory".into());
            }
            report(
                "verify",
                format!("Checking {}", entry.path.display()),
                completed,
            );
            if !file_matches(&destination, entry)? {
                if destination.symlink_metadata().is_ok() {
                    return Err(format!(
                        "Existing resource is different: {}. Choose a new installation folder.",
                        entry.path.display()
                    ));
                }
                let mut response = client
                    .get(&entry.url)
                    .send()
                    .and_then(|r| r.error_for_status())
                    .map_err(|e| e.to_string())?;
                let mut output = tempfile::NamedTempFile::new_in(destination.parent().unwrap())
                    .map_err(|e| e.to_string())?;
                let mut received = 0u64;
                let mut buffer = vec![0; 1024 * 1024];
                loop {
                    let count = response.read(&mut buffer).map_err(|e| e.to_string())?;
                    if count == 0 {
                        break;
                    }
                    received += count as u64;
                    if received > entry.bytes {
                        return Err("Download exceeds its declared size".into());
                    }
                    output
                        .write_all(&buffer[..count])
                        .map_err(|e| e.to_string())?;
                    report(
                        "download",
                        format!("Downloading {}", entry.path.display()),
                        completed + received,
                    );
                }
                report(
                    "verify",
                    format!("Verifying {}", entry.path.display()),
                    completed + received,
                );
                if !file_matches(output.path(), entry)? {
                    return Err(format!(
                        "Checksum verification failed for {}",
                        entry.path.display()
                    ));
                }
                output.as_file().sync_all().map_err(|e| e.to_string())?;
                output
                    .persist_noclobber(&destination)
                    .map_err(|e| e.to_string())?;
            }
            #[cfg(unix)]
            if entry.executable {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&destination, fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
            if let Some(name) = &entry.archive_root {
                report(
                    "extract",
                    format!("Unpacking {name}"),
                    completed + entry.bytes,
                );
                crate::resource_archive::install(
                    &destination,
                    &root,
                    name,
                    entry.unpacked_bytes,
                    entry.manifest_sha256.as_deref(),
                )?;
                fs::remove_file(&destination).map_err(|e| e.to_string())?;
            }
            completed += entry.bytes;
        }
        report(
            "configure",
            "Checking the installed resources".into(),
            completed,
        );
        let bundle =
            resolve_bundle_paths(release.bundle.clone(), &root).map_err(|e| e.to_string())?;
        validate_resource_bundle(&bundle).map_err(|e| e.to_string())?;
        let descriptor = root.join("dgw-bundle.json");
        let mut output = tempfile::NamedTempFile::new_in(&root).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(&mut output, &release.bundle).map_err(|e| e.to_string())?;
        output.persist(&descriptor).map_err(|e| e.to_string())?;
        if !settings.registered.contains(&descriptor) {
            settings.registered.push(descriptor);
        }
        save_preferences(&app, &settings)?;
        report("complete", "Resources are ready".into(), total);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires DGW_TEST_DATA_ARCHIVE and DGW_TEST_TOOL_ARCHIVE"]
    fn native_release_pair_builds_a_valid_bundle() {
        let data_path = PathBuf::from(std::env::var("DGW_TEST_DATA_ARCHIVE").unwrap());
        let tool_path = PathBuf::from(std::env::var("DGW_TEST_TOOL_ARCHIVE").unwrap());
        let catalog = artifact_catalog().unwrap();
        let data = selected_artifact(&data_path, &catalog).unwrap();
        let tools = selected_artifact(&tool_path, &catalog).unwrap();
        assert_eq!(data.kind, "data");
        assert_eq!(tools.platform.as_deref(), Some(platform_id().as_str()));
        let root = tempfile::tempdir().unwrap();
        crate::resource_archive::install(
            &tool_path,
            root.path(),
            &tools.id,
            tools.unpacked_bytes,
            Some(&tools.manifest_sha256),
        )
        .unwrap();
        let manifest = crate::resource_archive::install(
            &data_path,
            root.path(),
            &data.id,
            data.unpacked_bytes,
            Some(&data.manifest_sha256),
        )
        .unwrap();
        let portable = bundle_from_archives(&data, &tools, &manifest).unwrap();
        let resolved = resolve_bundle_paths(portable, root.path()).unwrap();
        validate_resource_bundle(&resolved).unwrap();
    }
    #[test]
    fn verifies_downloads_and_rejects_escaping_paths() {
        assert!(!safe_relative(Path::new("../outside")));
        assert!(!safe_relative(Path::new("/outside")));
        assert!(safe_relative(Path::new("reference/genome.fa.gz")));
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("file");
        fs::write(&path, b"data").unwrap();
        let expected = ResourceFile {
            path: "file".into(),
            url: "https://example.org/file".into(),
            sha256: hex::encode(Sha256::digest(b"data")),
            bytes: 4,
            executable: false,
            archive_root: None,
            unpacked_bytes: 0,
            manifest_sha256: None,
        };
        assert!(file_matches(&path, &expected).unwrap());
        fs::write(&path, b"oops").unwrap();
        assert!(!file_matches(&path, &expected).unwrap());
    }
}
