use crate::error::{DgwError, Result};
use crate::model::*;
use crate::state::{
    effective_variants, materialize_haplotype, materialize_haplotype_masking_unphased,
    validate_edit_shape, validate_no_overlap,
};
use crate::vcf::{extract_selected_sample, fingerprint_file, validate_resource_bundle};
use chrono::Utc;
use flate2::read::MultiGzDecoder;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use uuid::Uuid;

const MANIFEST_FILE: &str = "manifest.json";
const DATABASE_FILE: &str = "project.sqlite";
const SOURCE_TRACK_NAME: &str = "Source genome";
const WORKING_TRACK_NAME: &str = "Working track";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub project_path: PathBuf,
    pub name: String,
    pub source_vcf_path: PathBuf,
    pub selected_sample: String,
    pub resource_bundle: ResourceBundle,
}

#[derive(Debug, Clone)]
pub struct Project {
    root: PathBuf,
    manifest: ProjectManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGenomeTrack {
    #[serde(flatten)]
    track: GenomeTrack,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    baseline_bypassed_edit_ids: Vec<String>,
}

impl Project {
    pub fn create(mut request: CreateProjectRequest) -> Result<Self> {
        let final_path = request.project_path.clone();
        prepare_project_destination(&final_path)?;

        let parent = final_path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let name = final_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("project.dgw");
        let staging_path = parent.join(format!(".{name}.creating-{}", Uuid::new_v4()));
        request.project_path = staging_path.clone();

        let result = Self::create_in_place(request).and_then(|mut project| {
            fs::rename(&staging_path, &final_path)?;
            project.root = final_path;
            Ok(project)
        });
        if result.is_err() && staging_path.exists() {
            let _ = fs::remove_dir_all(&staging_path);
        }
        result
    }

    fn create_in_place(request: CreateProjectRequest) -> Result<Self> {
        let mut warnings = validate_resource_bundle(&request.resource_bundle)?;
        fs::create_dir_all(request.project_path.join("artifacts"))?;
        fs::create_dir_all(request.project_path.join("exports"))?;

        let source_vcf = fingerprint_file(&request.source_vcf_path)?;
        let (headers, variants, import_warnings) = extract_selected_sample(
            &request.source_vcf_path,
            &request.resource_bundle.assembly,
            &request.selected_sample,
        )?;
        warnings.extend(import_warnings);
        let resource_bundle_fingerprint = bundle_fingerprint(&request.resource_bundle)?;
        let root_state_id = hash_text(&format!(
            "root|{}|{}|{}",
            source_vcf.sha256, request.selected_sample, resource_bundle_fingerprint
        ));
        let selected_vcf_path = PathBuf::from("artifacts/root.selected.vcf.gz");
        let manifest = ProjectManifest {
            schema_version: 1,
            project_id: Uuid::new_v4().to_string(),
            name: request.name,
            created_at: Utc::now(),
            source_vcf,
            selected_sample: request.selected_sample,
            assembly: request.resource_bundle.assembly.clone(),
            resource_bundle: request.resource_bundle,
            resource_bundle_fingerprint,
            root_state_id: root_state_id.clone(),
            selected_vcf_path,
        };

        let project = Self {
            root: request.project_path,
            manifest,
        };
        project.initialize_database(&root_state_id, &variants, &warnings)?;
        project.write_selected_vcf(&headers, &variants)?;
        project.write_manifest()?;
        Ok(project)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let root = path.as_ref().to_path_buf();
        let manifest_path = root.join(MANIFEST_FILE);
        let manifest: ProjectManifest = serde_json::from_reader(File::open(&manifest_path)?)?;
        if manifest.schema_version != 1 {
            return Err(DgwError::Project(format!(
                "unsupported project schema {}",
                manifest.schema_version
            )));
        }
        if !root.join(DATABASE_FILE).is_file() {
            return Err(DgwError::Project("project.sqlite is missing".into()));
        }
        let project = Self { root, manifest };
        // Opening an older package also performs the small, idempotent track migration.
        drop(project.connection()?);
        Ok(project)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn manifest(&self) -> &ProjectManifest {
        &self.manifest
    }

    fn connection(&self) -> Result<Connection> {
        let mut connection = Connection::open(self.root.join(DATABASE_FILE))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        self.ensure_track_schema(&mut connection)?;
        Ok(connection)
    }

    fn ensure_track_schema(&self, connection: &mut Connection) -> Result<()> {
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS tracks (
               id TEXT PRIMARY KEY,
               payload TEXT NOT NULL
             );",
        )?;

        let has_workspace_table: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace')",
            [],
            |row| row.get(0),
        )?;
        if !has_workspace_table {
            return Ok(());
        }
        let workspace_payload: Option<String> = connection
            .query_row(
                "SELECT payload FROM workspace WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(workspace_payload) = workspace_payload else {
            return Ok(());
        };
        let mut workspace: WorkspaceSnapshot = serde_json::from_str(&workspace_payload)?;
        let track_count: i64 =
            connection.query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))?;

        let transaction = connection.transaction()?;
        if track_count == 0 {
            let source = self.seed_source_track();
            let working =
                self.seed_working_track(&workspace.current_state_id, &workspace.bypassed_edit_ids);
            insert_track(&transaction, &source)?;
            insert_track(&transaction, &working)?;
            workspace.active_track_id = working.id;
        } else {
            let active = if workspace.active_track_id.is_empty() {
                first_available_track(&transaction, Some(&working_track_id(&self.manifest)))?
            } else {
                track_from_connection(&transaction, &workspace.active_track_id)
                    .ok()
                    .filter(|track| !track.archived)
                    .or(first_available_track(&transaction, None)?)
            }
            .ok_or_else(|| DgwError::Project("project has no available genome tracks".into()))?;
            workspace.active_track_id = active.id.clone();
            workspace.current_state_id = active.head_state_id;
            workspace.bypassed_edit_ids = active.bypassed_edit_ids;
        }
        transaction.execute(
            "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
            [serde_json::to_string(&workspace)?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn seed_source_track(&self) -> GenomeTrack {
        GenomeTrack {
            id: source_track_id(&self.manifest),
            name: SOURCE_TRACK_NAME.into(),
            base_state_id: self.manifest.root_state_id.clone(),
            head_state_id: self.manifest.root_state_id.clone(),
            bypassed_edit_ids: Vec::new(),
            read_only: true,
            created_at: self.manifest.created_at,
            updated_at: self.manifest.created_at,
            archived: false,
        }
    }

    fn seed_working_track(&self, head_state_id: &str, bypassed_edit_ids: &[String]) -> GenomeTrack {
        GenomeTrack {
            id: working_track_id(&self.manifest),
            name: WORKING_TRACK_NAME.into(),
            base_state_id: self.manifest.root_state_id.clone(),
            head_state_id: head_state_id.into(),
            bypassed_edit_ids: bypassed_edit_ids.to_vec(),
            read_only: false,
            created_at: self.manifest.created_at,
            updated_at: self.manifest.created_at,
            archived: false,
        }
    }

    fn initialize_database(
        &self,
        root_state_id: &str,
        variants: &[RootVariant],
        resource_warnings: &[String],
    ) -> Result<()> {
        let mut connection = self.connection()?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS root_variants (
               stable_key TEXT PRIMARY KEY,
               payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS states (
               id TEXT PRIMARY KEY,
               parent_id TEXT REFERENCES states(id),
               edit_id TEXT,
               payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS edits (
               id TEXT PRIMARY KEY,
               state_id TEXT NOT NULL UNIQUE REFERENCES states(id),
               payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS workspace (
               singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
               payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS evaluations (
               cache_key TEXT PRIMARY KEY,
               payload TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS warnings (
               message TEXT PRIMARY KEY
             );
             CREATE INDEX IF NOT EXISTS states_parent_idx ON states(parent_id);",
        )?;
        let transaction = connection.transaction()?;
        for variant in variants {
            transaction.execute(
                "INSERT INTO root_variants(stable_key, payload) VALUES (?1, ?2)",
                params![variant.key.stable_key(), serde_json::to_string(variant)?],
            )?;
        }
        let root_state = GenomeState {
            id: root_state_id.to_owned(),
            parent_id: None,
            edit_id: None,
            label: Some("Imported sample".into()),
            created_at: Utc::now(),
        };
        transaction.execute(
            "INSERT INTO states(id, parent_id, edit_id, payload) VALUES (?1, NULL, NULL, ?2)",
            params![root_state_id, serde_json::to_string(&root_state)?],
        )?;
        let initial_focus = variants.first().map(|first| {
            let cluster_end = variants
                .iter()
                .take_while(|variant| {
                    variant.key.contig == first.key.contig
                        && variant.key.position <= first.key.position.saturating_add(200)
                })
                .map(|variant| variant.key.end())
                .max()
                .unwrap_or_else(|| first.key.end());
            FocusContext {
                contig: first.key.contig.clone(),
                start: first.key.position.saturating_sub(20).max(1),
                end: cluster_end.saturating_add(20),
            }
        });
        let workspace = WorkspaceSnapshot {
            active_track_id: working_track_id(&self.manifest),
            current_state_id: root_state_id.to_owned(),
            bypassed_edit_ids: Vec::new(),
            a_state_id: Some(root_state_id.to_owned()),
            b_state_id: None,
            focus: initial_focus,
        };
        transaction.execute(
            "INSERT INTO workspace(singleton, payload) VALUES (1, ?1)",
            [serde_json::to_string(&workspace)?],
        )?;
        insert_track(&transaction, &self.seed_source_track())?;
        insert_track(&transaction, &self.seed_working_track(root_state_id, &[]))?;
        for warning in resource_warnings {
            transaction.execute(
                "INSERT OR IGNORE INTO warnings(message) VALUES (?1)",
                [warning],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn write_manifest(&self) -> Result<()> {
        let mut file = File::create(self.root.join(MANIFEST_FILE))?;
        serde_json::to_writer_pretty(&mut file, &self.manifest)?;
        file.write_all(b"\n")?;
        Ok(())
    }

    fn write_selected_vcf(&self, headers: &[String], variants: &[RootVariant]) -> Result<()> {
        let plain_path = self.root.join("artifacts/root.selected.vcf");
        // Freeze only the selected sample, never the original multi-sample payload.
        let mut selected = File::create(&plain_path)?;
        for header in headers {
            writeln!(selected, "{header}")?;
        }
        writeln!(selected, "##DGWProject={}", self.manifest.project_id)?;
        writeln!(
            selected,
            "##DGWSourceSHA256={}",
            self.manifest.source_vcf.sha256
        )?;
        writeln!(
            selected,
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t{}",
            self.manifest.selected_sample
        )?;
        for variant in variants {
            let fields: Vec<&str> = variant.source_line.split('\t').collect();
            let sample = variant.sample_values.join(":");
            writeln!(selected, "{}\t{}", fields[..9].join("\t"), sample)?;
        }
        drop(selected);

        self.validate_selected_vcf(&plain_path)?;

        let compressed = self.root.join(&self.manifest.selected_vcf_path);
        let output = File::create(&compressed)?;
        let status = Command::new(&self.manifest.resource_bundle.bgzip_path)
            .arg("-c")
            .arg(&plain_path)
            .stdout(Stdio::from(output))
            .status()?;
        if !status.success() {
            return Err(DgwError::Tool(
                "bgzip failed while creating root artifact".into(),
            ));
        }
        let status = Command::new(&self.manifest.resource_bundle.tabix_path)
            .args(["-f", "-C", "-p", "vcf"])
            .arg(&compressed)
            .status()?;
        if !status.success() {
            return Err(DgwError::Tool(
                "tabix failed while indexing root artifact".into(),
            ));
        }
        fs::remove_file(plain_path)?;
        Ok(())
    }

    fn validate_selected_vcf(&self, plain_path: &Path) -> Result<()> {
        let normalized_path = plain_path.with_extension("normalized.vcf");
        let output = Command::new(&self.manifest.resource_bundle.bcftools_path)
            .arg("norm")
            .args(["-c", "e", "-f"])
            .arg(&self.manifest.resource_bundle.reference_path)
            .args(["-m", "-both", "-Ov", "--no-version", "-o"])
            .arg(&normalized_path)
            .arg(plain_path)
            .output()?;
        if !output.status.success() {
            return Err(DgwError::InvalidVcf(format!(
                "bcftools REF/normalization validation failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        let keys = |path: &Path| -> Result<Vec<(String, String, String, String)>> {
            let file = BufReader::new(File::open(path)?);
            let mut result = Vec::new();
            for line in file.lines() {
                let line = line?;
                if line.starts_with('#') || line.is_empty() {
                    continue;
                }
                let fields: Vec<&str> = line.split('\t').collect();
                if fields.len() >= 5 {
                    result.push((
                        fields[0].into(),
                        fields[1].into(),
                        fields[3].into(),
                        fields[4].into(),
                    ));
                }
            }
            Ok(result)
        };
        let original_keys = keys(plain_path)?;
        let normalized_keys = keys(&normalized_path)?;
        fs::remove_file(&normalized_path)?;
        if original_keys != normalized_keys {
            return Err(DgwError::InvalidVcf(
                "selected sample contains alleles that are not left-aligned/minimal; normalize the source before importing"
                    .into(),
            ));
        }
        Ok(())
    }

    fn root_variants(&self) -> Result<Vec<RootVariant>> {
        let connection = self.connection()?;
        let mut statement =
            connection.prepare("SELECT payload FROM root_variants ORDER BY stable_key")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut variants = Vec::new();
        for row in rows {
            variants.push(serde_json::from_str(&row?)?);
        }
        variants.sort_by(|left: &RootVariant, right: &RootVariant| left.key.cmp(&right.key));
        Ok(variants)
    }

    pub fn states(&self) -> Result<Vec<GenomeState>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT payload FROM states ORDER BY rowid")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut states = Vec::new();
        for row in rows {
            states.push(serde_json::from_str(&row?)?);
        }
        Ok(states)
    }

    pub fn workspace(&self) -> Result<WorkspaceSnapshot> {
        let connection = self.connection()?;
        let payload: String = connection.query_row(
            "SELECT payload FROM workspace WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        Ok(serde_json::from_str(&payload)?)
    }

    pub fn list_tracks(&self) -> Result<Vec<GenomeTrack>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT payload FROM tracks ORDER BY rowid")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut tracks = Vec::new();
        for row in rows {
            let track: GenomeTrack = serde_json::from_str(&row?)?;
            if !track.archived {
                tracks.push(track);
            }
        }
        Ok(tracks)
    }

    pub fn active_track(&self) -> Result<GenomeTrack> {
        let workspace = self.workspace()?;
        self.track(&workspace.active_track_id)
    }

    fn track(&self, track_id: &str) -> Result<GenomeTrack> {
        Ok(self.stored_track(track_id)?.track)
    }

    fn stored_track(&self, track_id: &str) -> Result<StoredGenomeTrack> {
        let connection = self.connection()?;
        let stored = stored_track_from_connection(&connection, track_id)?;
        if stored.track.archived {
            return Err(DgwError::Project(format!(
                "genome track {track_id} has been archived"
            )));
        }
        Ok(stored)
    }

    pub fn select_track(&self, track_id: &str) -> Result<GenomeTrack> {
        let track = self.track(track_id)?;
        let mut workspace = self.workspace()?;
        workspace.active_track_id = track.id.clone();
        workspace.current_state_id = track.head_state_id.clone();
        workspace.bypassed_edit_ids = track.bypassed_edit_ids.clone();
        let connection = self.connection()?;
        connection.execute(
            "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
            [serde_json::to_string(&workspace)?],
        )?;
        Ok(track)
    }

    pub fn duplicate_track(&self, track_id: &str, name: impl Into<String>) -> Result<GenomeTrack> {
        let source = self.stored_track(track_id)?;
        let name = validated_track_name(name.into())?;
        let now = Utc::now();
        let track = GenomeTrack {
            id: Uuid::new_v4().to_string(),
            name,
            base_state_id: source.track.base_state_id,
            head_state_id: source.track.head_state_id,
            bypassed_edit_ids: source.track.bypassed_edit_ids,
            read_only: false,
            created_at: now,
            updated_at: now,
            archived: false,
        };
        let mut workspace = self.workspace()?;
        workspace.active_track_id = track.id.clone();
        workspace.current_state_id = track.head_state_id.clone();
        workspace.bypassed_edit_ids = track.bypassed_edit_ids.clone();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        insert_stored_track(
            &transaction,
            &StoredGenomeTrack {
                track: track.clone(),
                baseline_bypassed_edit_ids: source.baseline_bypassed_edit_ids,
            },
        )?;
        transaction.execute(
            "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
            [serde_json::to_string(&workspace)?],
        )?;
        transaction.commit()?;
        Ok(track)
    }

    pub fn rename_track(&self, track_id: &str, name: impl Into<String>) -> Result<GenomeTrack> {
        let mut track = self.track(track_id)?;
        track.name = validated_track_name(name.into())?;
        track.updated_at = Utc::now();
        let connection = self.connection()?;
        update_track(&connection, &track)?;
        Ok(track)
    }

    pub fn delete_track(&self, track_id: &str) -> Result<()> {
        let mut track = self.track(track_id)?;
        if track.read_only {
            return Err(DgwError::Project(
                "the read-only source genome track cannot be deleted".into(),
            ));
        }
        if self.workspace()?.active_track_id == track.id {
            return Err(DgwError::Project(
                "select another genome track before deleting the active track".into(),
            ));
        }
        let editable_remaining = self
            .list_tracks()?
            .into_iter()
            .filter(|candidate| !candidate.read_only && candidate.id != track.id)
            .count();
        if editable_remaining == 0 {
            return Err(DgwError::Project(
                "a project must keep at least one editable genome track".into(),
            ));
        }
        track.archived = true;
        track.updated_at = Utc::now();
        let connection = self.connection()?;
        update_track(&connection, &track)?;
        Ok(())
    }

    pub fn save_workspace(&self, workspace: &WorkspaceSnapshot) -> Result<()> {
        self.ensure_state_exists(&workspace.current_state_id)?;
        if let Some(state_id) = &workspace.a_state_id {
            self.ensure_state_exists(state_id)?;
        }
        if let Some(state_id) = &workspace.b_state_id {
            self.ensure_state_exists(state_id)?;
        }
        let stored_workspace = self.workspace()?;
        let active_track_id = if workspace.active_track_id.is_empty() {
            stored_workspace.active_track_id
        } else {
            workspace.active_track_id.clone()
        };
        let mut active_track = self.track(&active_track_id)?;
        if active_track.read_only
            && (active_track.head_state_id != workspace.current_state_id
                || active_track.bypassed_edit_ids != workspace.bypassed_edit_ids)
        {
            return Err(DgwError::Project(
                "the source genome track is read-only; duplicate it before making changes".into(),
            ));
        }
        active_track.head_state_id = workspace.current_state_id.clone();
        active_track.bypassed_edit_ids = workspace.bypassed_edit_ids.clone();
        active_track.updated_at = Utc::now();
        let mut workspace = workspace.clone();
        workspace.active_track_id = active_track.id.clone();
        workspace.current_state_id = active_track.head_state_id.clone();
        workspace.bypassed_edit_ids = active_track.bypassed_edit_ids.clone();

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        update_track(&transaction, &active_track)?;
        transaction.execute(
            "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
            [serde_json::to_string(&workspace)?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn ensure_state_exists(&self, state_id: &str) -> Result<()> {
        let connection = self.connection()?;
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM states WHERE id = ?1",
            [state_id],
            |row| row.get(0),
        )?;
        if count == 0 {
            return Err(DgwError::Project(format!("unknown state {state_id}")));
        }
        Ok(())
    }

    pub fn edits_to_state(&self, state_id: &str) -> Result<Vec<EditOperation>> {
        self.ensure_state_exists(state_id)?;
        let connection = self.connection()?;
        let mut current = state_id.to_owned();
        let mut edits = Vec::new();
        loop {
            let state_payload: String = connection.query_row(
                "SELECT payload FROM states WHERE id = ?1",
                [&current],
                |row| row.get(0),
            )?;
            let state: GenomeState = serde_json::from_str(&state_payload)?;
            if let Some(edit_id) = state.edit_id {
                let edit_payload: String = connection.query_row(
                    "SELECT payload FROM edits WHERE id = ?1",
                    [&edit_id],
                    |row| row.get(0),
                )?;
                edits.push(serde_json::from_str(&edit_payload)?);
            }
            match state.parent_id {
                Some(parent) => current = parent,
                None => break,
            }
        }
        edits.reverse();
        Ok(edits)
    }

    /// Returns the persistent edit blocks that are still visible on a track.
    ///
    /// The baseline state itself and every edit before it remain available in the
    /// audit ancestry, but are intentionally excluded from this list.
    pub fn edits_for_track(&self, track_id: &str) -> Result<Vec<EditOperation>> {
        let track = self.track(track_id)?;
        self.edits_between_states(&track.base_state_id, &track.head_state_id)
    }

    fn edits_between_states(
        &self,
        base_state_id: &str,
        head_state_id: &str,
    ) -> Result<Vec<EditOperation>> {
        self.ensure_state_exists(base_state_id)?;
        self.ensure_state_exists(head_state_id)?;
        if base_state_id == head_state_id {
            return Ok(Vec::new());
        }

        let connection = self.connection()?;
        let mut current = head_state_id.to_owned();
        let mut visited = BTreeSet::new();
        let mut edits = Vec::new();
        while current != base_state_id {
            if !visited.insert(current.clone()) {
                return Err(DgwError::Project(
                    "cycle detected in genome state ancestry".into(),
                ));
            }
            let state_payload: String = connection.query_row(
                "SELECT payload FROM states WHERE id = ?1",
                [&current],
                |row| row.get(0),
            )?;
            let state: GenomeState = serde_json::from_str(&state_payload)?;
            if let Some(edit_id) = state.edit_id {
                let edit_payload: String = connection.query_row(
                    "SELECT payload FROM edits WHERE id = ?1",
                    [&edit_id],
                    |row| row.get(0),
                )?;
                edits.push(serde_json::from_str(&edit_payload)?);
            }
            current = state.parent_id.ok_or_else(|| {
                DgwError::Project(format!(
                    "state {base_state_id} is not an ancestor of state {head_state_id}"
                ))
            })?;
        }
        edits.reverse();
        Ok(edits)
    }

    pub fn effective_variants(
        &self,
        state_id: &str,
        bypassed_edit_ids: &[String],
    ) -> Result<Vec<EffectiveVariant>> {
        effective_variants(
            &self.root_variants()?,
            &self.edits_to_state(state_id)?,
            bypassed_edit_ids,
        )
    }

    pub fn effective_variants_for_track(&self, track_id: &str) -> Result<Vec<EffectiveVariant>> {
        let stored = self.stored_track(track_id)?;
        let bypassed_edit_ids = effective_bypassed_edit_ids(&stored);
        self.effective_variants(&stored.track.head_state_id, &bypassed_edit_ids)
    }

    pub fn apply_edit_to_track(
        &self,
        track_id: &str,
        haplotype: Haplotype,
        edit: EditKind,
        note: Option<String>,
    ) -> Result<GenomeState> {
        let stored = self.stored_track(track_id)?;
        self.apply_edit_to_track_from(stored, haplotype, edit, note, None)
    }

    pub fn apply_edit(
        &self,
        parent_state_id: &str,
        haplotype: Haplotype,
        edit: EditKind,
        note: Option<String>,
        bypassed_edit_ids: &[String],
    ) -> Result<GenomeState> {
        let track = self.active_track()?;
        if track.head_state_id != parent_state_id {
            return Err(DgwError::Project(format!(
                "state {parent_state_id} is not the head of active track {}",
                track.id
            )));
        }
        let stored = self.stored_track(&track.id)?;
        self.apply_edit_to_track_from(stored, haplotype, edit, note, Some(bypassed_edit_ids))
    }

    fn apply_edit_to_track_from(
        &self,
        mut stored: StoredGenomeTrack,
        haplotype: Haplotype,
        edit: EditKind,
        note: Option<String>,
        bypassed_edit_ids: Option<&[String]>,
    ) -> Result<GenomeState> {
        if stored.track.read_only {
            return Err(DgwError::Project(
                "the source genome track is read-only; duplicate it before making changes".into(),
            ));
        }
        let visible_bypassed_edit_ids = bypassed_edit_ids
            .map(<[String]>::to_vec)
            .unwrap_or_else(|| stored.track.bypassed_edit_ids.clone());
        let mut effective_bypasses = stored.baseline_bypassed_edit_ids.clone();
        append_unique(&mut effective_bypasses, &visible_bypassed_edit_ids);
        validate_edit_shape(&edit)?;
        let effective =
            self.effective_variants(&stored.track.head_state_id, &effective_bypasses)?;
        validate_no_overlap(&effective, haplotype, &edit)?;
        let operation_id = Uuid::new_v4().to_string();
        let operation = EditOperation {
            id: operation_id.clone(),
            parent_state_id: stored.track.head_state_id.clone(),
            haplotype,
            edit,
            note,
            created_at: Utc::now(),
        };
        let mut candidate_operations = self.edits_to_state(&stored.track.head_state_id)?;
        candidate_operations.push(operation.clone());
        effective_variants(
            &self.root_variants()?,
            &candidate_operations,
            &effective_bypasses,
        )?;
        let state_id = hash_text(&format!(
            "{}|{}",
            stored.track.head_state_id,
            serde_json::to_string(&operation)?
        ));
        let state = GenomeState {
            id: state_id.clone(),
            parent_id: Some(stored.track.head_state_id.clone()),
            edit_id: Some(operation_id.clone()),
            label: None,
            created_at: operation.created_at,
        };
        let mut workspace = self.workspace()?;
        let is_active = workspace.active_track_id == stored.track.id;
        stored.track.head_state_id = state.id.clone();
        stored.track.bypassed_edit_ids = visible_bypassed_edit_ids;
        stored.track.updated_at = operation.created_at;
        if is_active {
            workspace.current_state_id = stored.track.head_state_id.clone();
            workspace.bypassed_edit_ids = stored.track.bypassed_edit_ids.clone();
        }

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO states(id, parent_id, edit_id, payload) VALUES (?1, ?2, ?3, ?4)",
            params![
                state_id,
                operation.parent_state_id,
                operation_id,
                serde_json::to_string(&state)?
            ],
        )?;
        transaction.execute(
            "INSERT INTO edits(id, state_id, payload) VALUES (?1, ?2, ?3)",
            params![operation.id, state.id, serde_json::to_string(&operation)?],
        )?;
        update_stored_track(&transaction, &stored)?;
        if is_active {
            transaction.execute(
                "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
                [serde_json::to_string(&workspace)?],
            )?;
        }
        transaction.commit()?;
        Ok(state)
    }

    pub fn set_track_bypassed_edit_ids(
        &self,
        track_id: &str,
        bypassed_edit_ids: &[String],
    ) -> Result<GenomeTrack> {
        let mut track = self.track(track_id)?;
        if track.read_only && !bypassed_edit_ids.is_empty() {
            return Err(DgwError::Project(
                "the source genome track is read-only".into(),
            ));
        }
        let available: BTreeSet<String> = self
            .edits_for_track(track_id)?
            .into_iter()
            .map(|edit| edit.id)
            .collect();
        let mut normalized = Vec::new();
        for edit_id in bypassed_edit_ids {
            if !available.contains(edit_id) {
                return Err(DgwError::Project(format!(
                    "edit {edit_id} does not belong to genome track {}",
                    track.id
                )));
            }
            if !normalized.contains(edit_id) {
                normalized.push(edit_id.clone());
            }
        }
        track.bypassed_edit_ids = normalized;
        track.updated_at = Utc::now();
        self.persist_track_and_active_workspace(&track)?;
        Ok(track)
    }

    pub fn toggle_track_edit_bypass(
        &self,
        track_id: &str,
        edit_id: &str,
        bypassed: bool,
    ) -> Result<GenomeTrack> {
        let track = self.track(track_id)?;
        let mut edit_ids = track.bypassed_edit_ids.clone();
        if bypassed {
            if !edit_ids.iter().any(|candidate| candidate == edit_id) {
                edit_ids.push(edit_id.into());
            }
        } else {
            edit_ids.retain(|candidate| candidate != edit_id);
        }
        self.set_track_bypassed_edit_ids(track_id, &edit_ids)
    }

    /// Consolidates all currently visible edit blocks into the track baseline.
    ///
    /// State and edit rows are never removed. Bypassed edits are retained as
    /// private baseline exclusions so consolidation preserves the exact effective
    /// genome while the public, post-baseline bypass list becomes empty.
    pub fn consolidate_track(&self, track_id: &str) -> Result<GenomeTrack> {
        let mut stored = self.stored_track(track_id)?;
        if stored.track.read_only {
            return Err(DgwError::Project(
                "the source genome track is read-only and cannot be consolidated".into(),
            ));
        }

        // This also verifies that the current baseline is an ancestor of the head.
        self.edits_for_track(track_id)?;
        let ancestry_ids: BTreeSet<String> = self
            .edits_to_state(&stored.track.head_state_id)?
            .into_iter()
            .map(|edit| edit.id)
            .collect();
        stored
            .baseline_bypassed_edit_ids
            .retain(|edit_id| ancestry_ids.contains(edit_id));
        let visible_bypasses = stored.track.bypassed_edit_ids.clone();
        for edit_id in visible_bypasses {
            if ancestry_ids.contains(&edit_id)
                && !stored.baseline_bypassed_edit_ids.contains(&edit_id)
            {
                stored.baseline_bypassed_edit_ids.push(edit_id);
            }
        }

        stored.track.base_state_id = stored.track.head_state_id.clone();
        stored.track.bypassed_edit_ids.clear();
        stored.track.updated_at = Utc::now();
        self.persist_stored_track_and_active_workspace(&stored)?;
        Ok(stored.track)
    }

    fn persist_track_and_active_workspace(&self, track: &GenomeTrack) -> Result<()> {
        let mut stored = self.stored_track(&track.id)?;
        stored.track = track.clone();
        self.persist_stored_track_and_active_workspace(&stored)
    }

    fn persist_stored_track_and_active_workspace(&self, stored: &StoredGenomeTrack) -> Result<()> {
        let mut workspace = self.workspace()?;
        let is_active = workspace.active_track_id == stored.track.id;
        if is_active {
            workspace.current_state_id = stored.track.head_state_id.clone();
            workspace.bypassed_edit_ids = stored.track.bypassed_edit_ids.clone();
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        update_stored_track(&transaction, stored)?;
        if is_active {
            transaction.execute(
                "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
                [serde_json::to_string(&workspace)?],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn snapshot(&self) -> Result<ProjectSnapshot> {
        let workspace = self.workspace()?;
        let active_stored = self.stored_track(&workspace.active_track_id)?;
        let active_track = active_stored.track.clone();
        let all_variants = self.effective_variants(
            &active_track.head_state_id,
            &effective_bypassed_edit_ids(&active_stored),
        )?;
        let variant_count = all_variants.len() as u64;
        let variants = match &workspace.focus {
            Some(context) => all_variants
                .into_iter()
                .filter(|variant| {
                    variant.key.contig == context.contig
                        && variant.key.position <= context.end
                        && variant.key.end() >= context.start
                })
                .collect(),
            None => all_variants.into_iter().take(1).collect(),
        };
        let connection = self.connection()?;
        let mut warning_statement =
            connection.prepare("SELECT message FROM warnings ORDER BY message")?;
        let rows = warning_statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut warnings = Vec::new();
        for row in rows {
            warnings.push(row?);
        }
        if !self.manifest.source_vcf.path.exists() {
            warnings.push(
                "Original VCF is unavailable; using the frozen selected-sample artifact".into(),
            );
        }
        Ok(ProjectSnapshot {
            manifest: self.manifest.clone(),
            workspace,
            tracks: self.list_tracks()?,
            active_track,
            states: self.states()?,
            variants,
            variant_count,
            warnings,
        })
    }

    pub fn focus_view(&self, context: FocusContext) -> Result<FocusView> {
        if context.start == 0 || context.end < context.start || context.end - context.start > 50_000
        {
            return Err(DgwError::Project(
                "focus must be a valid reference interval no wider than 50 kb".into(),
            ));
        }
        let workspace = self.workspace()?;
        let active_stored = self.stored_track(&workspace.active_track_id)?;
        let active_track = active_stored.track.clone();
        let all_variants = self.effective_variants(
            &active_track.head_state_id,
            &effective_bypassed_edit_ids(&active_stored),
        )?;
        let variants: Vec<EffectiveVariant> = all_variants
            .into_iter()
            .filter(|variant| {
                variant.key.contig == context.contig
                    && variant.key.position <= context.end
                    && variant.key.end() >= context.start
            })
            .collect();
        let mut warnings = Vec::new();
        let reference_sequence = match self.fetch_reference(&context) {
            Ok(sequence) => Some(sequence),
            Err(error) => {
                warnings.push(format!("Reference sequence unavailable: {error}"));
                None
            }
        };
        let haplotype1_sequence = match reference_sequence.as_deref() {
            Some(reference) => {
                match materialize_haplotype(reference, context.start, &variants, Haplotype::One) {
                    Ok(sequence) => Some(sequence),
                    Err(error) => {
                        warnings.push(format!(
                            "Chromosome copy A cannot be reconstructed in this focus: {error}"
                        ));
                        None
                    }
                }
            }
            None => None,
        };
        let haplotype2_sequence = match reference_sequence.as_deref() {
            Some(reference) => {
                match materialize_haplotype(reference, context.start, &variants, Haplotype::Two) {
                    Ok(sequence) => Some(sequence),
                    Err(error) => {
                        warnings.push(format!(
                            "Chromosome copy B cannot be reconstructed in this focus: {error}"
                        ));
                        None
                    }
                }
            }
            None => None,
        };
        if variants.iter().any(|variant| variant.unphased_alt) {
            warnings.push(
                "U marks phase-unknown alleles; they are not assigned to chromosome copy A or B"
                    .into(),
            );
        }
        let contig_length = self.reference_contig_length(&context.contig).ok();
        Ok(FocusView {
            context,
            contig_length,
            reference_sequence,
            haplotype1_sequence,
            haplotype2_sequence,
            variants,
            states: self.states()?,
            edits: self.edits_to_state(&active_track.head_state_id)?,
            tracks: self.list_tracks()?,
            active_track,
            workspace,
            warnings,
        })
    }

    /// Exports only a selected reference interval: the reference sequence and
    /// the chosen track's two reconstructed genome copies. Phase-unknown
    /// heterozygous alleles are masked on both copies and written to a TSV
    /// sidecar rather than assigned to an arbitrary copy.
    pub fn export_focus_fasta(
        &self,
        track_id: &str,
        context: FocusContext,
        output_path: impl AsRef<Path>,
    ) -> Result<FocusFastaExport> {
        if context.start == 0 || context.end < context.start || context.end - context.start > 50_000
        {
            return Err(DgwError::Project(
                "FASTA export must be a valid reference interval no wider than 50 kb".into(),
            ));
        }
        let stored = self.stored_track(track_id)?;
        let all_variants = self.effective_variants(
            &stored.track.head_state_id,
            &effective_bypassed_edit_ids(&stored),
        )?;
        let overlapping: Vec<EffectiveVariant> = all_variants
            .into_iter()
            .filter(|variant| {
                variant.key.contig == context.contig
                    && variant.key.position <= context.end
                    && variant.key.end() >= context.start
            })
            .collect();
        if let Some(boundary_variant) = overlapping
            .iter()
            .find(|variant| variant.key.position < context.start || variant.key.end() > context.end)
        {
            return Err(DgwError::Project(format!(
                "expand the focus so allele {} is fully contained before exporting FASTA",
                boundary_variant.key.display()
            )));
        }

        let reference = self.fetch_reference(&context)?;
        let copy1 = materialize_haplotype_masking_unphased(
            &reference,
            context.start,
            &overlapping,
            Haplotype::One,
        )?;
        let copy2 = materialize_haplotype_masking_unphased(
            &reference,
            context.start,
            &overlapping,
            Haplotype::Two,
        )?;
        let output_path = output_path.as_ref().to_path_buf();
        let region = format!("{}:{}-{}", context.contig, context.start, context.end);
        let track_name = fasta_token(&stored.track.name);
        let phase_label = if overlapping.iter().any(|variant| variant.unphased_alt) {
            "unphased_masked"
        } else {
            "resolved"
        };
        let mut output = File::create(&output_path)?;
        write_fasta_record(
            &mut output,
            &format!(
                "DGW_reference|assembly={}|region={region}",
                fasta_token(&self.manifest.assembly)
            ),
            &reference,
        )?;
        for (copy, sequence) in [("A", copy1.as_str()), ("B", copy2.as_str())] {
            write_fasta_record(
                &mut output,
                &format!(
                    "DGW_track_chromosome_copy_{copy}|track={track_name}|track_id={}|chromosome_copy={copy}|parental_origin=unknown|assembly={}|region={region}|phase={phase_label}",
                    stored.track.id,
                    fasta_token(&self.manifest.assembly)
                ),
                sequence,
            )?;
        }

        let unphased: Vec<&EffectiveVariant> = overlapping
            .iter()
            .filter(|variant| variant.unphased_alt)
            .collect();
        let uncertainty_path = if unphased.is_empty() {
            None
        } else {
            let path = uncertainty_sidecar_path(&output_path);
            let mut uncertainty = File::create(&path)?;
            writeln!(
                uncertainty,
                "# Phase-unknown heterozygous alleles masked with N on both FASTA copies"
            )?;
            writeln!(
                uncertainty,
                "assembly\tcontig\tposition\tref\talt\tchromosome_copy\ttrack_id"
            )?;
            for variant in &unphased {
                writeln!(
                    uncertainty,
                    "{}\t{}\t{}\t{}\t{}\tunknown\t{}",
                    variant.key.assembly,
                    variant.key.contig,
                    variant.key.position,
                    variant.key.reference,
                    variant.key.alternate,
                    stored.track.id
                )?;
            }
            Some(path)
        };

        Ok(FocusFastaExport {
            fasta_path: output_path,
            uncertainty_path,
            sequence_records: 3,
            masked_unphased_alleles: unphased.len() as u64,
        })
    }

    fn reference_contig_length(&self, contig: &str) -> Result<u64> {
        let fai = fs::read_to_string(&self.manifest.resource_bundle.reference_fai_path)?;
        let row = fai
            .lines()
            .find(|line| line.split('\t').next() == Some(contig))
            .ok_or_else(|| {
                DgwError::InvalidResource(format!(
                    "contig {contig} is absent from the reference FAI"
                ))
            })?;
        row.split('\t')
            .nth(1)
            .ok_or_else(|| DgwError::InvalidResource("reference FAI row is malformed".into()))?
            .parse()
            .map_err(|_| DgwError::InvalidResource("invalid FAI contig length".into()))
    }

    fn fetch_reference(&self, context: &FocusContext) -> Result<String> {
        let fai = fs::read_to_string(&self.manifest.resource_bundle.reference_fai_path)?;
        let fields: Vec<&str> = fai
            .lines()
            .find(|line| line.split('\t').next() == Some(context.contig.as_str()))
            .ok_or_else(|| {
                DgwError::InvalidResource(format!(
                    "contig {} is absent from the reference FAI",
                    context.contig
                ))
            })?
            .split('\t')
            .collect();
        if fields.len() < 5 {
            return Err(DgwError::InvalidResource(
                "reference FAI row is malformed".into(),
            ));
        }
        let contig_length: u64 = fields[1]
            .parse()
            .map_err(|_| DgwError::InvalidResource("invalid FAI contig length".into()))?;
        let sequence_offset: u64 = fields[2]
            .parse()
            .map_err(|_| DgwError::InvalidResource("invalid FAI sequence offset".into()))?;
        let line_bases: u64 = fields[3]
            .parse()
            .map_err(|_| DgwError::InvalidResource("invalid FAI line width".into()))?;
        let line_bytes: u64 = fields[4]
            .parse()
            .map_err(|_| DgwError::InvalidResource("invalid FAI line byte width".into()))?;
        if context.end > contig_length || line_bases == 0 || line_bytes < line_bases {
            return Err(DgwError::Project(
                "focus falls outside the indexed reference".into(),
            ));
        }
        let start_zero = context.start - 1;
        let uncompressed_offset =
            sequence_offset + (start_zero / line_bases) * line_bytes + (start_zero % line_bases);
        let requested_bases = context.end - context.start + 1;
        let newline_bytes = line_bytes - line_bases;
        let requested_bytes =
            requested_bases + ((requested_bases / line_bases) + 2) * newline_bytes;
        let output = Command::new(&self.manifest.resource_bundle.bgzip_path)
            .arg("-b")
            .arg(uncompressed_offset.to_string())
            .arg("-s")
            .arg(requested_bytes.to_string())
            .arg(&self.manifest.resource_bundle.reference_path)
            .output()?;
        if !output.status.success() {
            return Err(DgwError::Tool(
                String::from_utf8_lossy(&output.stderr).trim().into(),
            ));
        }
        let sequence: String = String::from_utf8_lossy(&output.stdout)
            .chars()
            .filter(|character| !character.is_ascii_whitespace())
            .take(requested_bases as usize)
            .collect();
        if sequence.len() != requested_bases as usize {
            return Err(DgwError::Tool(format!(
                "bgzip returned {} bases for a {}-base focus",
                sequence.len(),
                requested_bases
            )));
        }
        Ok(sequence)
    }

    pub fn cache_get(&self, cache_key: &str) -> Result<Option<EvaluationResult>> {
        let connection = self.connection()?;
        let result = connection.query_row(
            "SELECT payload FROM evaluations WHERE cache_key = ?1",
            [cache_key],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(payload) => Ok(Some(serde_json::from_str(&payload)?)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn cache_put(&self, result: &EvaluationResult) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT OR REPLACE INTO evaluations(cache_key, payload, created_at) VALUES (?1, ?2, ?3)",
            params![
                result.cache_key,
                serde_json::to_string(result)?,
                result.evaluated_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn render_state(
        &self,
        state_id: &str,
        bypassed_edit_ids: &[String],
        output_path: impl AsRef<Path>,
    ) -> Result<PathBuf> {
        let mut output_path = output_path.as_ref().to_path_buf();
        if !output_path.to_string_lossy().ends_with(".vcf.gz") {
            output_path.set_extension("vcf.gz");
        }
        let plain_path = output_path.with_extension("").with_extension("vcf");
        let variants = self.effective_variants(state_id, bypassed_edit_ids)?;
        let provenance_path = PathBuf::from(format!("{}.provenance.json", output_path.display()));
        let provenance = serde_json::json!({
            "schemaVersion": 1,
            "project": self.manifest,
            "stateId": state_id,
            "bypassedEditIds": bypassed_edit_ids,
            "edits": self.edits_to_state(state_id)?,
            "renderedAt": Utc::now(),
            "limitation": "SnpEff consequences are evaluated independently per variant; compound haplotype consequences are not computed in DGW v1."
        });
        let provenance_bytes = serde_json::to_vec_pretty(&provenance)?;
        let provenance_sha256 = hex::encode(Sha256::digest(&provenance_bytes));
        let mut provenance_file = File::create(&provenance_path)?;
        provenance_file.write_all(&provenance_bytes)?;
        provenance_file.write_all(b"\n")?;

        let mut output = File::create(&plain_path)?;
        writeln!(output, "##fileformat=VCFv4.3")?;
        for header in self.source_meta_headers()? {
            writeln!(output, "{header}")?;
        }
        writeln!(output, "##source=DGW-0.1.0")?;
        writeln!(
            output,
            "##reference={}",
            self.manifest.resource_bundle.reference_path.display()
        )?;
        writeln!(output, "##DGWProject={}", self.manifest.project_id)?;
        writeln!(output, "##DGWState={state_id}")?;
        writeln!(
            output,
            "##DGWSourceSHA256={}",
            self.manifest.source_vcf.sha256
        )?;
        writeln!(
            output,
            "##DGWResourceBundle={}",
            self.manifest.resource_bundle_fingerprint
        )?;
        writeln!(output, "##DGWProvenanceSHA256={provenance_sha256}")?;
        writeln!(
            output,
            "##INFO=<ID=DGW_ORIGIN,Number=1,Type=String,Description=\"DGW allele origin\">"
        )?;
        writeln!(output, "##INFO=<ID=DGW_EDIT_IDS,Number=.,Type=String,Description=\"DGW edit operation identifiers\">")?;
        writeln!(output, "##INFO=<ID=DGW_SOURCE_KEY,Number=1,Type=String,Description=\"Original normalized allele key\">")?;
        writeln!(output, "##INFO=<ID=DGW_EVAL_STATUS,Number=1,Type=String,Description=\"DGW live evaluation status\">")?;
        writeln!(
            output,
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t{}",
            self.manifest.selected_sample
        )?;
        for variant in &variants {
            let genotype = if variant.unphased_alt {
                "0/1"
            } else {
                match (variant.haplotype1_alt, variant.haplotype2_alt) {
                    (true, true) => "1|1",
                    (true, false) => "1|0",
                    (false, true) => "0|1",
                    (false, false) => continue,
                }
            };
            let origin = match variant.origin {
                VariantOrigin::Observed => "observed",
                VariantOrigin::Edited => "edited",
                VariantOrigin::Created => "created",
            };
            let mut info = if variant.origin == VariantOrigin::Observed {
                variant.source_info.clone()
            } else {
                BTreeMap::new()
            };
            info.insert("DGW_ORIGIN".into(), origin.into());
            if !variant.edit_ids.is_empty() {
                info.insert("DGW_EDIT_IDS".into(), variant.edit_ids.join(","));
            }
            if let Some(source) = &variant.source_key {
                info.insert("DGW_SOURCE_KEY".into(), source.stable_key());
            }
            let cache_key = crate::evaluation::evaluation_cache_key(
                &variant.key,
                &self.manifest.resource_bundle_fingerprint,
            );
            if let Some(evaluation) = self.cache_get(&cache_key)? {
                info.insert("DGW_EVAL_STATUS".into(), "computed".into());
                let annotations = evaluation
                    .snpeff
                    .records
                    .iter()
                    .filter_map(|record| record.get("raw"))
                    .cloned()
                    .collect::<Vec<_>>();
                if !annotations.is_empty() {
                    info.insert("ANN".into(), annotations.join(","));
                }
                for evidence in [&evaluation.clinvar, &evaluation.cosmic] {
                    if let Some(record) = evidence.records.first() {
                        for (key, value) in record {
                            if key != "raw" && key != "id" {
                                info.insert(key.clone(), value.clone());
                            }
                        }
                    }
                }
            } else {
                info.insert("DGW_EVAL_STATUS".into(), "not_computed".into());
            }
            let info_text = info
                .iter()
                .map(|(key, value)| {
                    if value == "true" {
                        key.clone()
                    } else {
                        format!("{key}={value}")
                    }
                })
                .collect::<Vec<_>>()
                .join(";");
            writeln!(
                output,
                "{}\t{}\t.\t{}\t{}\t.\tPASS\t{}\tGT\t{}",
                variant.key.contig,
                variant.key.position,
                variant.key.reference,
                variant.key.alternate,
                info_text,
                genotype
            )?;
        }
        drop(output);

        let compressed = File::create(&output_path)?;
        let status = Command::new(&self.manifest.resource_bundle.bgzip_path)
            .arg("-c")
            .arg(&plain_path)
            .stdout(Stdio::from(compressed))
            .status()?;
        if !status.success() {
            return Err(DgwError::Tool("bgzip failed while rendering state".into()));
        }
        let status = Command::new(&self.manifest.resource_bundle.tabix_path)
            .args(["-f", "-C", "-p", "vcf"])
            .arg(&output_path)
            .status()?;
        if !status.success() {
            return Err(DgwError::Tool(
                "tabix failed while indexing rendered state".into(),
            ));
        }
        fs::remove_file(&plain_path)?;
        Ok(output_path)
    }

    /// Renders a genome track using both its visible bypass choices and any
    /// private baseline exclusions retained by consolidation.
    pub fn render_track(&self, track_id: &str, output_path: impl AsRef<Path>) -> Result<PathBuf> {
        let stored = self.stored_track(track_id)?;
        self.render_state(
            &stored.track.head_state_id,
            &effective_bypassed_edit_ids(&stored),
            output_path,
        )
    }

    fn source_meta_headers(&self) -> Result<Vec<String>> {
        let path = self.root.join(&self.manifest.selected_vcf_path);
        let reader = BufReader::new(MultiGzDecoder::new(File::open(path)?));
        let mut headers = Vec::new();
        for line in reader.lines() {
            let line = line?;
            if line.starts_with("#CHROM") {
                break;
            }
            if line.starts_with("##")
                && !line.starts_with("##fileformat=")
                && !line.starts_with("##source=")
                && !line.starts_with("##reference=")
                && !line.starts_with("##DGW")
            {
                headers.push(line);
            }
        }
        Ok(headers)
    }
}

fn insert_track(connection: &Connection, track: &GenomeTrack) -> Result<()> {
    insert_stored_track(
        connection,
        &StoredGenomeTrack {
            track: track.clone(),
            baseline_bypassed_edit_ids: Vec::new(),
        },
    )
}

fn insert_stored_track(connection: &Connection, stored: &StoredGenomeTrack) -> Result<()> {
    connection.execute(
        "INSERT INTO tracks(id, payload) VALUES (?1, ?2)",
        params![stored.track.id, serde_json::to_string(stored)?],
    )?;
    Ok(())
}

fn update_track(connection: &Connection, track: &GenomeTrack) -> Result<()> {
    let mut stored = stored_track_from_connection(connection, &track.id)?;
    stored.track = track.clone();
    update_stored_track(connection, &stored)
}

fn update_stored_track(connection: &Connection, stored: &StoredGenomeTrack) -> Result<()> {
    let updated = connection.execute(
        "UPDATE tracks SET payload = ?2 WHERE id = ?1",
        params![stored.track.id, serde_json::to_string(stored)?],
    )?;
    if updated == 0 {
        return Err(DgwError::Project(format!(
            "unknown genome track {}",
            stored.track.id
        )));
    }
    Ok(())
}

fn track_from_connection(connection: &Connection, track_id: &str) -> Result<GenomeTrack> {
    Ok(stored_track_from_connection(connection, track_id)?.track)
}

fn stored_track_from_connection(
    connection: &Connection,
    track_id: &str,
) -> Result<StoredGenomeTrack> {
    let payload: Option<String> = connection
        .query_row(
            "SELECT payload FROM tracks WHERE id = ?1",
            [track_id],
            |row| row.get(0),
        )
        .optional()?;
    let payload =
        payload.ok_or_else(|| DgwError::Project(format!("unknown genome track {track_id}")))?;
    Ok(serde_json::from_str(&payload)?)
}

fn first_available_track(
    connection: &Connection,
    preferred_id: Option<&str>,
) -> Result<Option<GenomeTrack>> {
    if let Some(preferred_id) = preferred_id {
        if let Ok(track) = track_from_connection(connection, preferred_id) {
            if !track.archived {
                return Ok(Some(track));
            }
        }
    }
    let mut statement = connection.prepare("SELECT payload FROM tracks ORDER BY rowid")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        let track: GenomeTrack = serde_json::from_str::<StoredGenomeTrack>(&row?)?.track;
        if !track.archived {
            return Ok(Some(track));
        }
    }
    Ok(None)
}

fn source_track_id(manifest: &ProjectManifest) -> String {
    hash_text(&format!("track|{}|source", manifest.project_id))
}

fn working_track_id(manifest: &ProjectManifest) -> String {
    hash_text(&format!("track|{}|working", manifest.project_id))
}

fn validated_track_name(name: String) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(DgwError::Project(
            "genome track name cannot be empty".into(),
        ));
    }
    if name.chars().count() > 120 {
        return Err(DgwError::Project(
            "genome track name cannot exceed 120 characters".into(),
        ));
    }
    Ok(name.into())
}

fn fasta_token(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn write_fasta_record(output: &mut File, header: &str, sequence: &str) -> Result<()> {
    writeln!(output, ">{header}")?;
    for chunk in sequence.as_bytes().chunks(60) {
        output.write_all(chunk)?;
        output.write_all(b"\n")?;
    }
    Ok(())
}

fn uncertainty_sidecar_path(fasta_path: &Path) -> PathBuf {
    let mut path = fasta_path.to_path_buf();
    path.set_extension("unphased.tsv");
    path
}

fn append_unique(target: &mut Vec<String>, additions: &[String]) {
    for edit_id in additions {
        if !target.contains(edit_id) {
            target.push(edit_id.clone());
        }
    }
}

fn effective_bypassed_edit_ids(stored: &StoredGenomeTrack) -> Vec<String> {
    let mut bypassed = stored.baseline_bypassed_edit_ids.clone();
    append_unique(&mut bypassed, &stored.track.bypassed_edit_ids);
    bypassed
}

fn prepare_project_destination(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if !path.is_dir() {
        return Err(DgwError::Project(format!(
            "project package is not a directory: {}",
            path.display()
        )));
    }

    let entries = path
        .read_dir()?
        .map(|entry| entry.map(|value| value.file_name()))
        .collect::<std::io::Result<Vec<_>>>()?;
    let empty = entries.is_empty();
    let legacy_scaffold = !empty
        && entries
            .iter()
            .all(|entry| entry == "artifacts" || entry == "exports")
        && ["artifacts", "exports"].iter().all(|entry| {
            let candidate = path.join(entry);
            !candidate.exists()
                || (candidate.is_dir()
                    && candidate
                        .read_dir()
                        .map(|mut contents| contents.next().is_none())
                        .unwrap_or(false))
        });

    if empty {
        fs::remove_dir(path)?;
        return Ok(());
    }
    if legacy_scaffold {
        for entry in ["artifacts", "exports"] {
            let candidate = path.join(entry);
            if candidate.exists() {
                fs::remove_dir(candidate)?;
            }
        }
        fs::remove_dir(path)?;
        return Ok(());
    }

    Err(DgwError::Project(format!(
        "a project package already exists at {}. Open it, or choose a different project package name",
        path.display()
    )))
}

fn hash_text(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn bundle_fingerprint(bundle: &ResourceBundle) -> Result<String> {
    let mut bundle = bundle.clone();
    bundle.bundle_fingerprint = None;
    Ok(hash_text(&serde_json::to_string(&bundle)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::randomizer::{plan_randomizer, RandomizerRequest};
    use chrono::TimeZone;
    use std::io::Read;
    use tempfile::{tempdir, TempDir};

    fn test_resource(path: &Path) -> IndexedResource {
        IndexedResource {
            path: path.join("resource.vcf.gz"),
            index_path: path.join("resource.vcf.gz.tbi"),
            release: "test".into(),
            license_label: "test".into(),
            fingerprint: None,
        }
    }

    fn test_project() -> (TempDir, Project) {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("tracks.dgw");
        fs::create_dir_all(&root).unwrap();
        let created_at = Utc.with_ymd_and_hms(2026, 8, 27, 10, 0, 0).unwrap();
        let resource_bundle = ResourceBundle {
            schema_version: 1,
            id: "test-bundle".into(),
            assembly: "b37".into(),
            contig_style: "no_chr_prefix".into(),
            reference_path: temporary.path().join("reference.fa.gz"),
            reference_fai_path: temporary.path().join("reference.fa.gz.fai"),
            reference_gzi_path: None,
            java_path: temporary.path().join("java"),
            snpeff_jar_path: temporary.path().join("snpEff.jar"),
            snpeff_config_path: None,
            snpeff_genome: "hg19".into(),
            snpeff_version: "test".into(),
            bcftools_path: temporary.path().join("bcftools"),
            bgzip_path: "gzip".into(),
            tabix_path: "true".into(),
            dbnsfp: test_resource(temporary.path()),
            clinvar: test_resource(temporary.path()),
            cosmic: test_resource(temporary.path()),
            bundle_fingerprint: None,
        };
        let root_state_id = "test-root-state".to_string();
        let manifest = ProjectManifest {
            schema_version: 1,
            project_id: "test-project".into(),
            name: "Track tests".into(),
            created_at,
            source_vcf: FileFingerprint {
                path: temporary.path().join("source.vcf.gz"),
                sha256: "source-sha".into(),
                size: 0,
                modified_unix: None,
            },
            selected_sample: "TEST".into(),
            assembly: "b37".into(),
            resource_bundle,
            resource_bundle_fingerprint: "bundle-sha".into(),
            root_state_id: root_state_id.clone(),
            selected_vcf_path: "artifacts/root.selected.vcf.gz".into(),
        };
        let project = Project { root, manifest };
        project
            .initialize_database(&root_state_id, &[], &[])
            .unwrap();
        fs::create_dir_all(project.root.join("artifacts")).unwrap();
        let selected_vcf =
            File::create(project.root.join("artifacts/root.selected.vcf.gz")).unwrap();
        let mut selected_vcf =
            flate2::write::GzEncoder::new(selected_vcf, flate2::Compression::default());
        selected_vcf
            .write_all(
                b"##fileformat=VCFv4.3\n##contig=<ID=1>\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tTEST\n",
            )
            .unwrap();
        selected_vcf.finish().unwrap();
        project.write_manifest().unwrap();
        (temporary, project)
    }

    fn create_allele(position: u64, alternate: &str) -> EditKind {
        EditKind::SetAllele {
            key: VariantKey {
                assembly: "b37".into(),
                contig: "1".into(),
                position,
                reference: "A".into(),
                alternate: alternate.into(),
            },
            source_key: None,
        }
    }

    #[test]
    fn deterministic_hashes_are_stable() {
        assert_eq!(hash_text("DGW"), hash_text("DGW"));
        assert_ne!(hash_text("DGW"), hash_text("dgw"));
    }

    #[test]
    fn recovers_empty_scaffold_from_failed_legacy_creation() {
        let parent = tempdir().unwrap();
        let project = parent.path().join("example.dgw");
        fs::create_dir_all(project.join("artifacts")).unwrap();
        fs::create_dir_all(project.join("exports")).unwrap();

        prepare_project_destination(&project).unwrap();

        assert!(!project.exists());
    }

    #[test]
    fn refuses_to_replace_an_existing_project() {
        let parent = tempdir().unwrap();
        let project = parent.path().join("example.dgw");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("manifest.json"), "{}").unwrap();

        let error = prepare_project_destination(&project).unwrap_err();

        assert!(error.to_string().contains("already exists"));
        assert!(project.join("manifest.json").exists());
    }

    #[test]
    fn new_project_starts_with_source_and_editable_tracks() {
        let (_temporary, project) = test_project();

        let tracks = project.list_tracks().unwrap();
        let active = project.active_track().unwrap();
        let workspace = project.workspace().unwrap();

        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].name, SOURCE_TRACK_NAME);
        assert!(tracks[0].read_only);
        assert_eq!(tracks[0].head_state_id, project.manifest.root_state_id);
        assert_eq!(tracks[1].name, WORKING_TRACK_NAME);
        assert!(!tracks[1].read_only);
        assert_eq!(active.id, tracks[1].id);
        assert_eq!(workspace.active_track_id, active.id);
        assert_eq!(workspace.current_state_id, active.head_state_id);
        assert_eq!(workspace.bypassed_edit_ids, active.bypassed_edit_ids);

        let snapshot = project.snapshot().unwrap();
        assert_eq!(snapshot.tracks, tracks);
        assert_eq!(snapshot.active_track, active);
        let focus = project
            .focus_view(FocusContext {
                contig: "1".into(),
                start: 1,
                end: 10,
            })
            .unwrap();
        assert_eq!(focus.tracks, tracks);
        assert_eq!(focus.active_track.id, workspace.active_track_id);
    }

    #[test]
    fn appends_each_mutation_as_a_separate_visible_state() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let mut state_ids = BTreeSet::new();

        for position in 100..105 {
            let state = project
                .apply_edit_to_track(
                    &working.id,
                    Haplotype::One,
                    create_allele(position, "T"),
                    Some(format!("mutation {position}")),
                )
                .unwrap();
            assert!(state_ids.insert(state.id));
        }

        let track = project.track(&working.id).unwrap();
        assert_eq!(project.edits_for_track(&working.id).unwrap().len(), 5);
        assert_eq!(
            project
                .effective_variants_for_track(&working.id)
                .unwrap()
                .len(),
            5
        );
        assert!(state_ids.contains(&track.head_state_id));
    }

    #[test]
    fn applies_a_randomizer_plan_as_separate_reversible_track_edits() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        for (position, haplotype) in [
            (100, Haplotype::One),
            (100, Haplotype::Two),
            (110, Haplotype::Unphased),
        ] {
            project
                .apply_edit_to_track(
                    &working.id,
                    haplotype,
                    create_allele(position, "T"),
                    Some("randomizer fixture".into()),
                )
                .unwrap();
        }
        let before = project.effective_variants_for_track(&working.id).unwrap();
        let plan = plan_randomizer(
            &before,
            &RandomizerRequest {
                selected_variants: before.iter().map(|variant| variant.key.clone()).collect(),
                amount: 100,
                seed: 42,
            },
        )
        .unwrap();
        assert_eq!(plan.randomized_positions, 2);
        assert_eq!(plan.generated_edits, 3);

        for proposal in &plan.proposals {
            project
                .apply_edit_to_track(
                    &working.id,
                    proposal.haplotype,
                    proposal.edit.clone(),
                    Some("Allele Randomizer · seed 42 · amount 100%".into()),
                )
                .unwrap();
        }

        let after = project.effective_variants_for_track(&working.id).unwrap();
        assert_eq!(after.len(), 2);
        assert!(after.iter().all(|variant| variant.key.alternate != "T"));
        assert_eq!(project.edits_for_track(&working.id).unwrap().len(), 6);
    }

    #[test]
    fn duplicate_tracks_diverge_without_changing_their_source() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        project
            .apply_edit_to_track(
                &working.id,
                Haplotype::One,
                create_allele(100, "T"),
                Some("first edit".into()),
            )
            .unwrap();
        let working_after_first_edit = project.track(&working.id).unwrap();

        let duplicate = project
            .duplicate_track(&working.id, "Alternative model")
            .unwrap();
        assert_eq!(
            duplicate.base_state_id,
            working_after_first_edit.base_state_id
        );
        assert_eq!(
            duplicate.head_state_id,
            working_after_first_edit.head_state_id
        );
        assert_eq!(project.active_track().unwrap().id, duplicate.id);

        project
            .apply_edit_to_track(
                &duplicate.id,
                Haplotype::Two,
                create_allele(200, "G"),
                Some("second edit".into()),
            )
            .unwrap();

        let original = project.track(&working.id).unwrap();
        let duplicate = project.track(&duplicate.id).unwrap();
        assert_eq!(
            original.head_state_id,
            working_after_first_edit.head_state_id
        );
        assert_ne!(duplicate.head_state_id, original.head_state_id);
        assert_eq!(
            project
                .effective_variants_for_track(&original.id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            project
                .effective_variants_for_track(&duplicate.id)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(project.edits_for_track(&original.id).unwrap().len(), 1);
        assert_eq!(project.edits_for_track(&duplicate.id).unwrap().len(), 2);
        let source = project
            .list_tracks()
            .unwrap()
            .into_iter()
            .find(|track| track.read_only)
            .unwrap();
        assert!(project.edits_for_track(&source.id).unwrap().is_empty());
    }

    #[test]
    fn track_selection_and_bypass_are_isolated_and_mirrored() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let state = project
            .apply_edit_to_track(&working.id, Haplotype::One, create_allele(100, "T"), None)
            .unwrap();
        let edit_id = state.edit_id.unwrap();
        let duplicate = project
            .duplicate_track(&working.id, "Bypassed model")
            .unwrap();

        project
            .toggle_track_edit_bypass(&duplicate.id, &edit_id, true)
            .unwrap();
        assert!(project
            .effective_variants_for_track(&duplicate.id)
            .unwrap()
            .is_empty());
        assert_eq!(
            project
                .effective_variants_for_track(&working.id)
                .unwrap()
                .len(),
            1
        );

        project.select_track(&working.id).unwrap();
        let workspace = project.workspace().unwrap();
        let active = project.active_track().unwrap();
        assert_eq!(active.id, working.id);
        assert_eq!(workspace.active_track_id, active.id);
        assert_eq!(workspace.current_state_id, active.head_state_id);
        assert_eq!(workspace.bypassed_edit_ids, active.bypassed_edit_ids);
        assert!(workspace.bypassed_edit_ids.is_empty());
    }

    #[test]
    fn source_active_and_last_editable_tracks_are_protected_from_deletion() {
        let (_temporary, project) = test_project();
        let tracks = project.list_tracks().unwrap();
        let source = tracks.iter().find(|track| track.read_only).unwrap().clone();
        let working = tracks
            .iter()
            .find(|track| !track.read_only)
            .unwrap()
            .clone();

        assert!(project.delete_track(&source.id).is_err());
        assert!(project.delete_track(&working.id).is_err());

        let duplicate = project.duplicate_track(&working.id, "Disposable").unwrap();
        assert!(project.delete_track(&duplicate.id).is_err());
        project.select_track(&working.id).unwrap();
        project.delete_track(&duplicate.id).unwrap();
        assert!(!project
            .list_tracks()
            .unwrap()
            .iter()
            .any(|track| track.id == duplicate.id));

        project.select_track(&source.id).unwrap();
        let error = project.delete_track(&working.id).unwrap_err();
        assert!(error.to_string().contains("at least one editable"));
    }

    #[test]
    fn legacy_workspace_is_migrated_to_deterministic_tracks() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let state = project
            .apply_edit_to_track(
                &working.id,
                Haplotype::Unphased,
                create_allele(100, "T"),
                None,
            )
            .unwrap();
        let edit_id = state.edit_id.clone().unwrap();
        project
            .set_track_bypassed_edit_ids(&working.id, std::slice::from_ref(&edit_id))
            .unwrap();
        let legacy_workspace = project.workspace().unwrap();

        let connection = Connection::open(project.root.join(DATABASE_FILE)).unwrap();
        connection.execute("DROP TABLE tracks", []).unwrap();
        let mut legacy_json = serde_json::to_value(&legacy_workspace).unwrap();
        legacy_json.as_object_mut().unwrap().remove("activeTrackId");
        connection
            .execute(
                "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
                [serde_json::to_string(&legacy_json).unwrap()],
            )
            .unwrap();
        drop(connection);

        let reopened = Project::open(&project.root).unwrap();
        let tracks = reopened.list_tracks().unwrap();
        let active = reopened.active_track().unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].id, source_track_id(reopened.manifest()));
        assert_eq!(tracks[1].id, working_track_id(reopened.manifest()));
        assert_eq!(active.id, tracks[1].id);
        assert_eq!(active.head_state_id, legacy_workspace.current_state_id);
        assert_eq!(active.bypassed_edit_ids, vec![edit_id]);

        let reopened_again = Project::open(&project.root).unwrap();
        assert_eq!(reopened_again.list_tracks().unwrap(), tracks);
    }

    #[test]
    fn consolidation_hides_blocks_but_preserves_effective_genome_and_audit() {
        let (temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let first = project
            .apply_edit_to_track(
                &working.id,
                Haplotype::One,
                create_allele(100, "T"),
                Some("will remain bypassed in the baseline".into()),
            )
            .unwrap();
        let second = project
            .apply_edit_to_track(
                &working.id,
                Haplotype::Two,
                create_allele(200, "G"),
                Some("enabled at consolidation".into()),
            )
            .unwrap();
        let first_edit_id = first.edit_id.unwrap();
        project
            .toggle_track_edit_bypass(&working.id, &first_edit_id, true)
            .unwrap();

        let before = project.effective_variants_for_track(&working.id).unwrap();
        let audit_before = project.edits_to_state(&second.id).unwrap();
        let state_count_before = project.states().unwrap().len();
        assert_eq!(project.edits_for_track(&working.id).unwrap().len(), 2);
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].key.position, 200);

        let consolidated = project.consolidate_track(&working.id).unwrap();
        assert_eq!(consolidated.base_state_id, consolidated.head_state_id);
        assert!(consolidated.bypassed_edit_ids.is_empty());
        assert!(project.edits_for_track(&working.id).unwrap().is_empty());
        assert_eq!(
            project.effective_variants_for_track(&working.id).unwrap(),
            before
        );
        assert_eq!(
            project.edits_to_state(&consolidated.head_state_id).unwrap(),
            audit_before
        );
        assert_eq!(project.states().unwrap().len(), state_count_before);
        assert!(project.workspace().unwrap().bypassed_edit_ids.is_empty());

        let rendered_path = project
            .render_track(&working.id, temporary.path().join("consolidated.vcf.gz"))
            .unwrap();
        let mut rendered = String::new();
        MultiGzDecoder::new(File::open(&rendered_path).unwrap())
            .read_to_string(&mut rendered)
            .unwrap();
        assert!(rendered.lines().any(|line| line.starts_with("1\t200\t")));
        assert!(!rendered.lines().any(|line| line.starts_with("1\t100\t")));
        let provenance_path = PathBuf::from(format!("{}.provenance.json", rendered_path.display()));
        let provenance: serde_json::Value =
            serde_json::from_reader(File::open(provenance_path).unwrap()).unwrap();
        assert!(provenance["bypassedEditIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == &first_edit_id));

        let duplicate = project
            .duplicate_track(&working.id, "Consolidated copy")
            .unwrap();
        assert!(project.edits_for_track(&duplicate.id).unwrap().is_empty());
        assert_eq!(
            project.effective_variants_for_track(&duplicate.id).unwrap(),
            before
        );

        let third = project
            .apply_edit_to_track(
                &duplicate.id,
                Haplotype::Unphased,
                create_allele(300, "C"),
                Some("new visible block".into()),
            )
            .unwrap();
        let visible = project.edits_for_track(&duplicate.id).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, third.edit_id.clone().unwrap());
        project
            .toggle_track_edit_bypass(&duplicate.id, third.edit_id.as_deref().unwrap(), true)
            .unwrap();
        assert_eq!(
            project.effective_variants_for_track(&duplicate.id).unwrap(),
            before
        );

        let source = project
            .list_tracks()
            .unwrap()
            .into_iter()
            .find(|track| track.read_only)
            .unwrap();
        assert!(project.consolidate_track(&source.id).is_err());
    }
}
