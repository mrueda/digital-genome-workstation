//! Unpack checksum-verified tool archives, never arbitrary user-supplied archives.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read},
    path::{Component, Path},
};

const MAX_UNPACKED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveManifest {
    pub(crate) schema_version: u32,
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) platform: Option<String>,
    #[serde(default)]
    pub(crate) assembly: Option<String>,
    pub(crate) files: Vec<ManifestFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManifestFile {
    pub(crate) path: std::path::PathBuf,
    pub(crate) sha256: String,
    pub(crate) bytes: u64,
    #[serde(default)]
    pub(crate) role: Option<String>,
    #[serde(default)]
    pub(crate) source_url: Option<String>,
    #[serde(default)]
    pub(crate) release: Option<String>,
    #[serde(default)]
    pub(crate) license_label: Option<String>,
}

fn safe_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.components().all(|c| matches!(c, Component::Normal(_)))
        && !path.to_string_lossy().contains(['\\', ':'])
}

/// The caller verifies the compressed archive hash against the trusted catalog first.
/// Extract into private staging, then publish without replacing an existing package.
pub fn install(
    archive: &Path,
    root: &Path,
    name: &str,
    limit: u64,
    manifest_sha256: Option<&str>,
) -> Result<ArchiveManifest, String> {
    if !safe_path(Path::new(name)) || name.contains('/') || limit == 0 || limit > MAX_UNPACKED_BYTES
    {
        return Err("Invalid resource archive descriptor".into());
    }
    let manifest_sha256 = manifest_sha256
        .filter(|value| valid_sha256(value))
        .ok_or("Resource archive does not have a valid pinned manifest checksum")?;
    let stage = tempfile::tempdir_in(root).map_err(|e| e.to_string())?;
    let input = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut packed = tar::Archive::new(flate2::read::GzDecoder::new(input));
    let mut paths = BTreeSet::new();
    let mut size = 0u64;
    let mut files = Vec::new();
    for entry in packed.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let kind = entry.header().entry_type();
        if !safe_path(&path)
            || !path.starts_with(name)
            || !(kind.is_file() || kind.is_dir())
            || !paths.insert(path.clone())
            || paths.len() > 10000
        {
            return Err("Unsafe or duplicate resource archive entry".into());
        }
        size = size
            .checked_add(entry.size())
            .ok_or("Resource archive size overflow")?;
        if size > limit {
            return Err("Resource archive exceeds its unpacked size limit".into());
        }
        let destination = stage.path().join(&path);
        if kind.is_dir() {
            fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
        } else {
            fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut out = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|e| e.to_string())?;
            let copied = io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            if copied != entry.size() {
                return Err("Truncated tool archive entry".into());
            }
            out.sync_all().map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let executable = entry.header().mode().map_err(|e| e.to_string())? & 0o111 != 0;
                fs::set_permissions(
                    &destination,
                    fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }),
                )
                .map_err(|e| e.to_string())?;
            }
            files.push(path);
        }
    }
    if files.is_empty() {
        return Err("Empty resource archive".into());
    }
    let manifest = verify_manifest(&stage.path().join(name), name, manifest_sha256)?;
    let destination = root.join(name);
    if destination.symlink_metadata().is_ok() {
        // Retry after an interrupted later installation stage: only reuse identical files.
        let mut existing = BTreeSet::new();
        collect_files(root, &destination, &mut existing)?;
        if existing != files.iter().cloned().collect() {
            return Err("Existing tool package differs; choose a new installation folder".into());
        }
        for path in files {
            if !same_file(&root.join(&path), &stage.path().join(&path))
                .map_err(|e| e.to_string())?
            {
                return Err(
                    "Existing tool package differs; choose a new installation folder".into(),
                );
            }
        }
        return Ok(manifest);
    }
    fs::rename(stage.path().join(name), destination).map_err(|e| e.to_string())?;
    Ok(manifest)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hash(path: &Path) -> Result<String, String> {
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 1024 * 1024];
    loop {
        let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn platform_id() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

fn verify_manifest(
    directory: &Path,
    name: &str,
    expected_hash: &str,
) -> Result<ArchiveManifest, String> {
    let manifest_path = directory.join("manifest.json");
    if hash(&manifest_path)? != expected_hash.to_ascii_lowercase() {
        return Err("Resource package manifest checksum does not match the catalog".into());
    }
    let manifest: ArchiveManifest =
        serde_json::from_reader(fs::File::open(&manifest_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Invalid resource package manifest: {e}"))?;
    if manifest.schema_version != 1 || manifest.id != name {
        return Err("Resource package manifest identity does not match the catalog".into());
    }
    if manifest
        .platform
        .as_deref()
        .is_some_and(|value| value != platform_id())
    {
        return Err("Tool package does not support this computer".into());
    }
    let mut declared = BTreeSet::new();
    for entry in &manifest.files {
        if !safe_path(&entry.path)
            || !valid_sha256(&entry.sha256)
            || !declared.insert(entry.path.clone())
        {
            return Err("Invalid or duplicate file in resource package manifest".into());
        }
        let path = directory.join(&entry.path);
        let metadata = path.symlink_metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file()
            || metadata.len() != entry.bytes
            || hash(&path)? != entry.sha256.to_ascii_lowercase()
        {
            return Err(format!(
                "Resource package file failed verification: {}",
                entry.path.display()
            ));
        }
    }
    let required: &[&str] = if name.starts_with("dgw-tools-") {
        if cfg!(windows) {
            &["bin/bcftools.exe", "bin/bgzip.exe", "bin/tabix.exe"]
        } else {
            &["bin/bcftools", "bin/bgzip", "bin/tabix"]
        }
    } else if name.starts_with("dgw-data-") {
        &[
            "reference/genome.fa.gz",
            "reference/genome.fa.gz.fai",
            "reference/genome.fa.gz.gzi",
            "evidence/clinvar.vcf.gz",
            "evidence/clinvar.vcf.gz.tbi",
            "genes/genes.gtf.gz",
            "genes/genes.sqlite",
            "consequence/transcripts.gff3.gz",
        ]
    } else {
        return Err("Unknown resource package type".into());
    };
    if required
        .iter()
        .any(|path| !declared.contains(Path::new(path)))
    {
        return Err("Resource package is missing required files".into());
    }
    let mut actual = BTreeSet::new();
    collect_files(directory, directory, &mut actual)?;
    declared.insert("manifest.json".into());
    if directory.join("NOTICE.txt").is_file() {
        declared.insert("NOTICE.txt".into());
    }
    if actual != declared {
        return Err(format!(
            "Resource package contains files not covered by its manifest: {:?}",
            actual.difference(&declared).collect::<Vec<_>>()
        ));
    }
    Ok(manifest)
}

pub(crate) fn verify_installed(
    directory: &Path,
    name: &str,
    expected_hash: &str,
) -> Result<ArchiveManifest, String> {
    verify_manifest(directory, name, expected_hash)
}

fn same_file(a: &Path, b: &Path) -> io::Result<bool> {
    let mut a = fs::File::open(a)?;
    let mut b = fs::File::open(b)?;
    if a.metadata()?.len() != b.metadata()?.len() {
        return Ok(false);
    }
    let mut remaining = a.metadata()?.len();
    let mut left = [0; 65536];
    let mut right = [0; 65536];
    while remaining > 0 {
        let count = remaining.min(left.len() as u64) as usize;
        a.read_exact(&mut left[..count])?;
        b.read_exact(&mut right[..count])?;
        if left[..count] != right[..count] {
            return Ok(false);
        }
        remaining -= count as u64;
    }
    Ok(true)
}

fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut BTreeSet<std::path::PathBuf>,
) -> Result<(), String> {
    if !directory
        .symlink_metadata()
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("Existing tool directory is not a regular directory".into());
    }
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            collect_files(root, &entry.path(), files)?;
        } else if kind.is_file() {
            files.insert(entry.path().strip_prefix(root).unwrap().to_owned());
        } else {
            return Err("Existing tool package contains a link or special file".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires a checksum-verified native CI archive in DGW_TEST_TOOL_ARCHIVE"]
    fn native_package_archive() {
        let archive = std::path::PathBuf::from(std::env::var("DGW_TEST_TOOL_ARCHIVE").unwrap());
        let name = archive
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_suffix(".tar.gz")
            .unwrap();
        let root = tempfile::tempdir().unwrap();
        let manifest_hash = manifest_hash(&archive);
        let unpacked = unpacked_size(&archive);
        install(&archive, root.path(), name, unpacked, Some(&manifest_hash)).unwrap();
        install(&archive, root.path(), name, unpacked, Some(&manifest_hash)).unwrap();
        assert!(root.path().join(name).join("manifest.json").is_file());
        let binary = root.path().join(name).join("bin").join(if cfg!(windows) {
            "bcftools.exe"
        } else {
            "bcftools"
        });
        assert!(std::process::Command::new(binary)
            .arg("--version")
            .output()
            .unwrap()
            .status
            .success());
    }
    #[test]
    #[ignore = "Requires a checksum-verified data archive in DGW_TEST_DATA_ARCHIVE"]
    fn native_data_archive() {
        let archive = std::path::PathBuf::from(std::env::var("DGW_TEST_DATA_ARCHIVE").unwrap());
        let name = archive
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_suffix(".tar.gz")
            .unwrap();
        let checksum = manifest_hash(&archive);
        let root = tempfile::tempdir().unwrap();
        install(
            &archive,
            root.path(),
            name,
            unpacked_size(&archive),
            Some(&checksum),
        )
        .unwrap();
        assert!(root
            .path()
            .join(name)
            .join("reference/genome.fa.gz")
            .is_file());
        assert!(root.path().join(name).join("genes/genes.sqlite").is_file());
    }
    fn archive(path: &Path, entries: &[(&str, &[u8], tar::EntryType)]) {
        let out = fs::File::create(path).unwrap();
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            out,
            flate2::Compression::default(),
        ));
        for (name, data, kind) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_entry_type(*kind);
            header.set_cksum();
            builder.append_data(&mut header, name, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
    }
    fn manifest_hash(path: &Path) -> String {
        let input = fs::File::open(path).unwrap();
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(input));
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            if entry.path().unwrap().ends_with("manifest.json") {
                let mut data = Vec::new();
                entry.read_to_end(&mut data).unwrap();
                return hex::encode(Sha256::digest(data));
            }
        }
        panic!("missing manifest")
    }
    fn unpacked_size(path: &Path) -> u64 {
        let input = fs::File::open(path).unwrap();
        tar::Archive::new(flate2::read::GzDecoder::new(input))
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().size())
            .sum()
    }
    fn valid_archive(path: &Path) -> String {
        let file_hash = hex::encode(Sha256::digest(b"executable"));
        let tool_paths: Vec<String> = ["bcftools", "bgzip", "tabix"]
            .iter()
            .map(|tool| format!("bin/{tool}{}", std::env::consts::EXE_SUFFIX))
            .collect();
        let manifest = serde_json::json!({"schemaVersion":1,"id":"dgw-tools-test",
            "platform":platform_id(),"files":[
                {"path":tool_paths[0],"sha256":file_hash,"bytes":10},
                {"path":tool_paths[1],"sha256":file_hash,"bytes":10},
                {"path":tool_paths[2],"sha256":file_hash,"bytes":10}]});
        let manifest = serde_json::to_vec(&manifest).unwrap();
        archive(
            path,
            &[
                (
                    &format!("dgw-tools-test/{}", tool_paths[0]),
                    b"executable",
                    tar::EntryType::Regular,
                ),
                (
                    &format!("dgw-tools-test/{}", tool_paths[1]),
                    b"executable",
                    tar::EntryType::Regular,
                ),
                (
                    &format!("dgw-tools-test/{}", tool_paths[2]),
                    b"executable",
                    tar::EntryType::Regular,
                ),
                (
                    "dgw-tools-test/manifest.json",
                    &manifest,
                    tar::EntryType::Regular,
                ),
            ],
        );
        hex::encode(Sha256::digest(manifest))
    }
    #[test]
    fn installs_retries_and_preserves_modified_files() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("tools.tar.gz");
        let checksum = valid_archive(&source);
        install(
            &source,
            root.path(),
            "dgw-tools-test",
            1000,
            Some(&checksum),
        )
        .unwrap();
        install(
            &source,
            root.path(),
            "dgw-tools-test",
            1000,
            Some(&checksum),
        )
        .unwrap();
        let binary = root.path().join(format!(
            "dgw-tools-test/bin/bcftools{}", std::env::consts::EXE_SUFFIX
        ));
        fs::write(&binary, b"modified").unwrap();
        assert!(install(
            &source,
            root.path(),
            "dgw-tools-test",
            1000,
            Some(&checksum)
        )
        .is_err());
        assert_eq!(
            fs::read(&binary).unwrap(),
            b"modified"
        );
    }
    #[test]
    fn rejects_links_wrong_roots_duplicates_and_size_overruns() {
        for entries in [
            vec![("tools/link", &b""[..], tar::EntryType::Symlink)],
            vec![("outside/file", &b"x"[..], tar::EntryType::Regular)],
            vec![("tools/file", &b"x"[..], tar::EntryType::Regular); 2],
            vec![("tools/file", &b"too large"[..], tar::EntryType::Regular)],
        ] {
            let root = tempfile::tempdir().unwrap();
            let source = root.path().join("tools.tar.gz");
            archive(&source, &entries);
            assert!(install(&source, root.path(), "tools", 2, Some(&"0".repeat(64))).is_err());
            assert!(!root.path().join("tools").exists());
        }
        for path in ["../escape", "/absolute", "C:/drive", "tools\\escape"] {
            assert!(!safe_path(Path::new(path)));
        }
    }
}
