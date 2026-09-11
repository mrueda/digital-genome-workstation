use crate::error::{DgwError, Result};
use crate::gene::GeneSearchHit;
use crate::model::*;
use crate::randomizer::{
    compact_randomizer_preview, plan_randomizer, RandomizerPreviewResult, RandomizerRequest,
    MAX_RANDOMIZER_POSITIONS,
};
use crate::state::{
    effective_variants, materialize_haplotype, materialize_haplotype_masking_unphased,
    validate_edit_shape, validate_no_overlap,
};
use crate::vcf::{
    contig_rank, fingerprint_file, reference_contigs, resolve_reference_contig,
    stream_selected_sample, validate_resource_bundle,
};
use chrono::Utc;
use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rusqlite::{params, Connection, OptionalExtension};
use serde::ser::SerializeSeq;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use uuid::Uuid;

const MANIFEST_FILE: &str = "manifest.json";
const DATABASE_FILE: &str = "project.sqlite";
const SOURCE_TRACK_NAME: &str = "Source genome";
const WORKING_TRACK_NAME: &str = "Working track";
pub const MAX_TRACK_REGION_VARIANTS: usize = 500;
pub const VARIANT_PAGE_SIZE: u32 = 200;
pub const VARIANT_DENSITY_BINS: u32 = 256;
pub const MAX_SEQUENCE_FOCUS_BASES: u64 = 50_000;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceSidecar<'a> {
    schema_version: u32,
    project_id: &'a str,
    state_id: &'a str,
    generated_at: chrono::DateTime<Utc>,
    resource_bundle: EvidenceResourceIdentity<'a>,
    coverage: EvidenceCoverage,
    evaluations: CachedEvaluationEntries<'a>,
    limitation: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceResourceIdentity<'a> {
    id: &'a str,
    assembly: &'a str,
    fingerprint: &'a str,
    consequence_engine: &'static str,
    bcftools_version: &'a str,
    consequence_annotation_release: Option<&'a str>,
    clinvar_release: &'a str,
    cosmic_release: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceCoverage {
    cached_exact_allele_entries: usize,
    scope: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRunsSidecar {
    schema_version: u32,
    project_id: String,
    generated_at: chrono::DateTime<Utc>,
    scope: &'static str,
    run_count: usize,
    runs: Vec<DeviceRunRecord>,
    limitation: &'static str,
}

struct CachedEvaluationEntries<'a> {
    connection: &'a Connection,
    count: usize,
}

impl Serialize for CachedEvaluationEntries<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut statement = self
            .connection
            .prepare("SELECT payload FROM evaluations ORDER BY created_at, cache_key")
            .map_err(serde::ser::Error::custom)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(serde::ser::Error::custom)?;
        let mut sequence = serializer.serialize_seq(Some(self.count))?;
        for row in rows {
            let payload = row.map_err(serde::ser::Error::custom)?;
            let evaluation: EvaluationResult =
                serde_json::from_str(&payload).map_err(serde::ser::Error::custom)?;
            sequence.serialize_element(&evaluation)?;
        }
        sequence.end()
    }
}

impl Project {
    pub fn create(request: CreateProjectRequest) -> Result<Self> {
        Self::create_with_progress(request, |_| {})
    }

    pub fn create_with_progress<F>(
        mut request: CreateProjectRequest,
        mut on_progress: F,
    ) -> Result<Self>
    where
        F: FnMut(ProcessProgress),
    {
        on_progress(ProcessProgress::new(
            "vcfImport",
            "destination",
            "Checking the project destination",
            1,
            10,
        ));
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

        let result = Self::create_in_place(request, &mut on_progress).and_then(|mut project| {
            on_progress(ProcessProgress::new(
                "vcfImport",
                "finalize",
                "Moving the completed package into place",
                9,
                10,
            ));
            fs::rename(&staging_path, &final_path)?;
            project.root = final_path;
            Ok(project)
        });
        if result.is_err() && staging_path.exists() {
            let _ = fs::remove_dir_all(&staging_path);
        }
        result
    }

    fn create_in_place<F>(request: CreateProjectRequest, on_progress: &mut F) -> Result<Self>
    where
        F: FnMut(ProcessProgress),
    {
        on_progress(ProcessProgress::new(
            "vcfImport",
            "resources",
            "Validating resources and fingerprinting the source VCF",
            2,
            10,
        ));
        let warnings = validate_resource_bundle(&request.resource_bundle)?;
        fs::create_dir_all(request.project_path.join("artifacts"))?;
        fs::create_dir_all(request.project_path.join("exports"))?;

        let source_vcf = fingerprint_file(&request.source_vcf_path)?;
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
            copied_from_project_id: None,
        };

        let project = Self {
            root: request.project_path,
            manifest,
        };
        on_progress(ProcessProgress::new(
            "vcfImport",
            "database",
            "Creating the project database and genome tracks",
            3,
            10,
        ));
        project.initialize_database(&root_state_id, &[], &warnings)?;
        project.import_selected_sample_stream(&request.source_vcf_path, on_progress)?;
        on_progress(ProcessProgress::new(
            "vcfImport",
            "manifest",
            "Writing project provenance and manifest",
            8,
            10,
        ));
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
        project.ensure_schema()?;
        Ok(project)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn manifest(&self) -> &ProjectManifest {
        &self.manifest
    }

    fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(self.root.join(DATABASE_FILE))?;
        connection.busy_timeout(Duration::from_secs(30))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Ok(connection)
    }

    fn ensure_schema(&self) -> Result<()> {
        let mut connection = self.connection()?;
        self.ensure_variant_schema(&mut connection)?;
        self.ensure_track_schema(&mut connection)?;
        self.ensure_job_schema(&mut connection)?;
        Ok(())
    }

    /// Keep the public project format at v1 while adding queryable columns to
    /// older SQLite databases. The payload remains the compatibility record;
    /// these columns are an internal, idempotent projection used for bounded
    /// region/page access.
    fn ensure_variant_schema(&self, connection: &mut Connection) -> Result<()> {
        let has_root_table: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'root_variants')",
            [],
            |row| row.get(0),
        )?;
        if !has_root_table {
            return Ok(());
        }

        let mut columns = BTreeSet::new();
        {
            let mut statement = connection.prepare("PRAGMA table_info(root_variants)")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            for row in rows {
                columns.insert(row?);
            }
        }
        for (name, sql_type) in [
            ("assembly", "TEXT"),
            ("contig", "TEXT"),
            ("position", "INTEGER"),
            ("end_position", "INTEGER"),
            ("reference", "TEXT"),
            ("alternate", "TEXT"),
        ] {
            if !columns.contains(name) {
                connection.execute(
                    &format!("ALTER TABLE root_variants ADD COLUMN {name} {sql_type}"),
                    [],
                )?;
            }
        }
        let needs_backfill: bool = connection.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM root_variants
                 WHERE contig IS NULL OR position IS NULL OR end_position IS NULL
            )",
            [],
            |row| row.get(0),
        )?;
        if needs_backfill {
            connection.execute_batch(
                "UPDATE root_variants
                SET assembly = json_extract(payload, '$.key.assembly'),
                    contig = json_extract(payload, '$.key.contig'),
                    position = json_extract(payload, '$.key.position'),
                    end_position = json_extract(payload, '$.key.position')
                        + length(json_extract(payload, '$.key.reference')) - 1,
                    reference = json_extract(payload, '$.key.reference'),
                    alternate = json_extract(payload, '$.key.alternate')
              WHERE contig IS NULL OR position IS NULL OR end_position IS NULL;",
            )?;
        }
        connection.execute_batch(
            "CREATE INDEX IF NOT EXISTS root_variants_region_idx
                ON root_variants(contig, position, end_position);
             CREATE INDEX IF NOT EXISTS root_variants_locus_idx
                ON root_variants(assembly, contig, position, reference, alternate);",
        )?;
        Ok(())
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

        if track_count == 0 {
            let transaction = connection.transaction()?;
            let source = self.seed_source_track();
            let working =
                self.seed_working_track(&workspace.current_state_id, &workspace.bypassed_edit_ids);
            insert_track(&transaction, &source)?;
            insert_track(&transaction, &working)?;
            workspace.active_track_id = working.id;
            transaction.execute(
                "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
                [serde_json::to_string(&workspace)?],
            )?;
            transaction.commit()?;
        } else {
            let active = if workspace.active_track_id.is_empty() {
                first_available_track(connection, Some(&working_track_id(&self.manifest)))?
            } else {
                track_from_connection(connection, &workspace.active_track_id)
                    .ok()
                    .filter(|track| !track.archived)
                    .or(first_available_track(connection, None)?)
            }
            .ok_or_else(|| DgwError::Project("project has no available genome tracks".into()))?;
            let changed = workspace.active_track_id != active.id
                || workspace.current_state_id != active.head_state_id
                || workspace.bypassed_edit_ids != active.bypassed_edit_ids;
            if changed {
                workspace.active_track_id = active.id.clone();
                workspace.current_state_id = active.head_state_id;
                workspace.bypassed_edit_ids = active.bypassed_edit_ids;
                connection.execute(
                    "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
                    [serde_json::to_string(&workspace)?],
                )?;
            }
        }
        Ok(())
    }

    fn ensure_job_schema(&self, connection: &mut Connection) -> Result<()> {
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS background_jobs (
               id TEXT PRIMARY KEY,
               status TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS background_jobs_updated_idx
               ON background_jobs(updated_at DESC);
             CREATE TABLE IF NOT EXISTS device_runs (
               id TEXT PRIMARY KEY,
               completed_at TEXT NOT NULL,
               device_id TEXT NOT NULL,
               track_id TEXT NOT NULL,
               input_state_id TEXT NOT NULL,
               payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS device_runs_completed_idx
               ON device_runs(completed_at DESC, id DESC);
             CREATE INDEX IF NOT EXISTS device_runs_device_idx
               ON device_runs(device_id, completed_at DESC);
             CREATE INDEX IF NOT EXISTS device_runs_track_idx
               ON device_runs(track_id, completed_at DESC);
             CREATE TABLE IF NOT EXISTS compound_mutation_layers (
               id TEXT PRIMARY KEY,
               track_id TEXT NOT NULL,
               source_state_id TEXT NOT NULL,
               applied_edit_id TEXT,
               payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS compound_mutation_changes (
               layer_id TEXT NOT NULL REFERENCES compound_mutation_layers(id) ON DELETE CASCADE,
               ordinal INTEGER NOT NULL,
               assembly TEXT NOT NULL,
               contig TEXT NOT NULL,
               position INTEGER NOT NULL,
               end_position INTEGER NOT NULL,
               payload TEXT NOT NULL,
               PRIMARY KEY(layer_id, ordinal)
             );
             CREATE INDEX IF NOT EXISTS compound_mutation_changes_region_idx
               ON compound_mutation_changes(layer_id, assembly, contig, position, end_position);
             CREATE TABLE IF NOT EXISTS workstation_session (
               singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
               schema_version INTEGER NOT NULL,
               updated_at TEXT NOT NULL,
               payload TEXT NOT NULL
             );",
        )?;
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
               payload TEXT NOT NULL,
               assembly TEXT NOT NULL,
               contig TEXT NOT NULL,
               position INTEGER NOT NULL,
               end_position INTEGER NOT NULL,
               reference TEXT NOT NULL,
               alternate TEXT NOT NULL
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
             CREATE INDEX IF NOT EXISTS states_parent_idx ON states(parent_id);
             CREATE INDEX IF NOT EXISTS root_variants_region_idx
               ON root_variants(contig, position, end_position);
             CREATE INDEX IF NOT EXISTS root_variants_locus_idx
               ON root_variants(assembly, contig, position, reference, alternate);",
        )?;
        self.ensure_variant_schema(&mut connection)?;
        self.ensure_track_schema(&mut connection)?;
        self.ensure_job_schema(&mut connection)?;
        let transaction = connection.transaction()?;
        for variant in variants {
            transaction.execute(
                "INSERT INTO root_variants(
                    stable_key, payload, assembly, contig, position, end_position, reference, alternate
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    variant.key.stable_key(),
                    serde_json::to_string(variant)?,
                    variant.key.assembly,
                    variant.key.contig,
                    variant.key.position,
                    variant.key.end(),
                    variant.key.reference,
                    variant.key.alternate,
                ],
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

    fn import_selected_sample_stream<F>(
        &self,
        source_path: &Path,
        on_progress: &mut F,
    ) -> Result<()>
    where
        F: FnMut(ProcessProgress),
    {
        on_progress(ProcessProgress::new(
            "vcfImport",
            "projection",
            "Keeping PASS calls and projecting the selected sample",
            4,
            10,
        ));
        let plain_path = self.root.join("artifacts/root.selected.vcf");
        let body_path = self.root.join("artifacts/root.selected.body.tmp");
        let projected_path = self.root.join("artifacts/root.selected.projected.tmp.vcf");
        let normalized_path = self.root.join("artifacts/root.selected.normalized.tmp.vcf");
        let mut body = File::create(&body_path)?;
        let reference_names = reference_contigs(&self.manifest.resource_bundle.reference_fai_path)?;
        let mut contig_mapping = BTreeMap::<String, String>::new();
        let (headers, import_warnings) = stream_selected_sample(
            source_path,
            &self.manifest.assembly,
            &self.manifest.selected_sample,
            |variant| {
                let fields: Vec<&str> = variant.source_line.split('\t').collect();
                if fields.len() < 9 {
                    return Err(DgwError::InvalidVcf(format!(
                        "selected record has fewer than nine VCF columns at {}",
                        variant.key.display()
                    )));
                }
                let canonical_contig = resolve_reference_contig(fields[0], &reference_names)?;
                if contig_mapping
                    .iter()
                    .any(|(source, target)| source != fields[0] && target == &canonical_contig)
                {
                    return Err(DgwError::InvalidVcf(format!(
                        "input uses multiple names for reference contig {canonical_contig}; use one contig convention per VCF"
                    )));
                }
                if let Some(previous) =
                    contig_mapping.insert(fields[0].into(), canonical_contig.clone())
                {
                    if previous != canonical_contig {
                        return Err(DgwError::InvalidVcf(format!(
                            "contig {} maps inconsistently to the configured reference",
                            fields[0]
                        )));
                    }
                }
                let mut projected_fields = fields[..9].to_vec();
                projected_fields[0] = &canonical_contig;
                writeln!(
                    body,
                    "{}\t{}",
                    projected_fields.join("\t"),
                    variant.sample_values.join(":")
                )?;
                Ok(())
            },
        )?;
        drop(body);

        // Freeze only a selected-sample projection before normalization. The
        // original VCF remains external and immutable.
        let mut selected = File::create(&projected_path)?;
        for header in headers {
            writeln!(
                selected,
                "{}",
                rewrite_vcf_contig_header(&header, &reference_names)?
            )?;
        }
        writeln!(selected, "##DGWProject={}", self.manifest.project_id)?;
        writeln!(
            selected,
            "##DGWSourceSHA256={}",
            self.manifest.source_vcf.sha256
        )?;
        writeln!(
            selected,
            "##DGWImportNormalization=<Method=bcftools_norm,ResourceBundleFingerprint={}>",
            self.manifest.resource_bundle_fingerprint
        )?;
        let renamed_contigs = contig_mapping
            .iter()
            .filter(|(source, target)| source.as_str() != target.as_str())
            .count();
        writeln!(
            selected,
            "##DGWContigMapping=<CanonicalStyle={},RenamedContigs={}>",
            self.manifest.resource_bundle.contig_style, renamed_contigs
        )?;
        writeln!(
            selected,
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t{}",
            self.manifest.selected_sample
        )?;
        std::io::copy(&mut File::open(&body_path)?, &mut selected)?;
        drop(selected);
        fs::remove_file(&body_path)?;

        on_progress(ProcessProgress::new(
            "vcfImport",
            "normalization",
            "Normalizing and sorting exact alleles with bcftools",
            5,
            10,
        ));
        let normalization =
            self.normalize_selected_vcf(&projected_path, &normalized_path, &plain_path)?;
        fs::remove_file(&projected_path)?;
        fs::remove_file(&normalized_path)?;

        on_progress(ProcessProgress::new(
            "vcfImport",
            "variants",
            "Writing normalized alleles to the project database",
            6,
            10,
        ));
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let mut insert = transaction.prepare(
            "INSERT INTO root_variants(
                stable_key, payload, assembly, contig, position, end_position, reference, alternate
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        let mut first_key: Option<VariantKey> = None;
        let mut cluster_end = 0_u64;
        let (_, normalized_warnings) = stream_selected_sample(
            &plain_path,
            &self.manifest.assembly,
            &self.manifest.selected_sample,
            |variant| {
                if first_key.is_none() {
                    first_key = Some(variant.key.clone());
                    cluster_end = variant.key.end();
                } else if first_key.as_ref().is_some_and(|first| {
                    variant.key.contig == first.contig
                        && variant.key.position <= first.position.saturating_add(200)
                }) {
                    cluster_end = cluster_end.max(variant.key.end());
                }

                // The frozen BGZF artifact is the sole projected VCF record
                // copy. SQLite stores only fields needed by the editor.
                let mut stored = variant.clone();
                stored.info.clear();
                stored.format_keys.clear();
                stored.sample_values.clear();
                stored.source_line.clear();
                insert.execute(params![
                    stored.key.stable_key(),
                    serde_json::to_string(&stored)?,
                    &stored.key.assembly,
                    &stored.key.contig,
                    stored.key.position,
                    stored.key.end(),
                    &stored.key.reference,
                    &stored.key.alternate,
                ])?;
                Ok(())
            },
        )?;
        drop(insert);

        if first_key.is_none() {
            return Err(DgwError::InvalidVcf(
                "the selected sample has no supported non-reference FILTER=PASS alleles to import"
                    .into(),
            ));
        }

        let workspace_payload: String = transaction.query_row(
            "SELECT payload FROM workspace WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let mut workspace: WorkspaceSnapshot = serde_json::from_str(&workspace_payload)?;
        workspace.focus = first_key.as_ref().map(|first| FocusContext {
            contig: first.contig.clone(),
            start: first.position.saturating_sub(20).max(1),
            end: cluster_end.saturating_add(20),
        });
        transaction.execute(
            "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
            [serde_json::to_string(&workspace)?],
        )?;
        let mut warnings = import_warnings;
        if renamed_contigs > 0 {
            let examples = contig_mapping
                .iter()
                .filter(|(source, target)| source.as_str() != target.as_str())
                .take(4)
                .map(|(source, target)| format!("{source}->{target}"))
                .collect::<Vec<_>>()
                .join(", ");
            warnings.push(format!(
                "DGW mapped {renamed_contigs} input contig name{} to the configured reference convention{}{}",
                if renamed_contigs == 1 { "" } else { "s" },
                if examples.is_empty() { "" } else { ": " },
                examples
            ));
        }
        warnings.extend(normalized_warnings);
        if let Some(warning) = normalization.warning() {
            warnings.push(warning);
        }
        for warning in warnings {
            transaction.execute(
                "INSERT OR IGNORE INTO warnings(message) VALUES (?1)",
                [warning],
            )?;
        }
        transaction.commit()?;

        on_progress(ProcessProgress::new(
            "vcfImport",
            "index",
            "Compressing and indexing the frozen project VCF",
            7,
            10,
        ));
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

    fn normalize_selected_vcf(
        &self,
        projected_path: &Path,
        normalized_path: &Path,
        sorted_path: &Path,
    ) -> Result<NormalizationSummary> {
        let output = Command::new(&self.manifest.resource_bundle.bcftools_path)
            .arg("norm")
            .args(["-c", "e", "-f"])
            .arg(&self.manifest.resource_bundle.reference_path)
            .args(["-Ov", "--no-version", "-o"])
            .arg(&normalized_path)
            .arg(projected_path)
            .output()?;
        if !output.status.success() {
            return Err(DgwError::InvalidVcf(format!(
                "DGW could not normalize the selected sample against the configured reference: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }

        let summary = compare_vcf_normalization(projected_path, normalized_path)?;
        let output = Command::new(&self.manifest.resource_bundle.bcftools_path)
            .arg("sort")
            .args(["-Ov", "-o"])
            .arg(sorted_path)
            .arg(normalized_path)
            .output()?;
        if !output.status.success() {
            return Err(DgwError::InvalidVcf(format!(
                "DGW normalized the selected sample but could not sort the project copy: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(summary)
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

    fn root_variant_count(&self) -> Result<u64> {
        let connection = self.connection()?;
        let count: i64 =
            connection.query_row("SELECT COUNT(*) FROM root_variants", [], |row| row.get(0))?;
        Ok(count.max(0) as u64)
    }

    pub fn source_variant_count_in_context(&self, context: &FocusContext) -> Result<u64> {
        let connection = self.connection()?;
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM root_variants
              WHERE contig = ?1 AND position <= ?2 AND end_position >= ?3",
            params![&context.contig, context.end, context.start],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as u64)
    }

    /// Search the assembly-matched gene index pinned by this project and add
    /// the number of imported source alleles overlapping each returned gene.
    /// Keeping this operation in the core gives desktop and command-based
    /// clients the same coordinate translation and counting semantics.
    pub fn search_genes(&self, query: &str, limit: u32) -> Result<Vec<GeneSearchHit>> {
        let resource = self
            .manifest
            .resource_bundle
            .gene_annotation
            .as_ref()
            .ok_or_else(|| {
                DgwError::InvalidResource(
                    "this project has no gene annotation resource configured".into(),
                )
            })?;
        let loci =
            crate::gene::search_gene_index(&resource.index_path, query, limit.clamp(1, 100))?;
        loci.into_iter()
            .map(|mut locus| {
                locus.contig = crate::vcf::translate_contig_style(
                    &locus.contig,
                    &self.manifest.resource_bundle.contig_style,
                );
                let source_variant_count = self.source_variant_count_in_context(&FocusContext {
                    contig: locus.contig.clone(),
                    start: locus.start,
                    end: locus.end,
                })?;
                Ok(GeneSearchHit {
                    locus,
                    source_variant_count,
                })
            })
            .collect()
    }

    fn root_variants_in_context(
        &self,
        context: &FocusContext,
        limit: Option<usize>,
        offset: u64,
    ) -> Result<Vec<RootVariant>> {
        let connection = self.connection()?;
        let sql = if limit.is_some() {
            "SELECT payload FROM root_variants
              WHERE contig = ?1 AND position <= ?2 AND end_position >= ?3
              ORDER BY position, reference, alternate LIMIT ?4 OFFSET ?5"
        } else {
            "SELECT payload FROM root_variants
              WHERE contig = ?1 AND position <= ?2 AND end_position >= ?3
              ORDER BY position, reference, alternate"
        };
        let mut statement = connection.prepare(sql)?;
        let mut variants = Vec::new();
        if let Some(limit) = limit {
            let rows = statement.query_map(
                params![
                    context.contig,
                    context.end,
                    context.start,
                    limit as u64,
                    offset
                ],
                |row| row.get::<_, String>(0),
            )?;
            for row in rows {
                variants.push(serde_json::from_str(&row?)?);
            }
        } else {
            let rows = statement
                .query_map(params![context.contig, context.end, context.start], |row| {
                    row.get::<_, String>(0)
                })?;
            for row in rows {
                variants.push(serde_json::from_str(&row?)?);
            }
        }
        Ok(variants)
    }

    fn root_variants_at_loci(&self, keys: &[VariantKey]) -> Result<Vec<RootVariant>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT payload FROM root_variants
              WHERE assembly = ?1 AND contig = ?2 AND position = ?3
                AND NOT (end_position < ?4 OR position > ?5)
              ORDER BY reference, alternate",
        )?;
        let mut seen = BTreeSet::new();
        let mut variants = Vec::new();
        for key in keys {
            let rows = statement.query_map(
                params![
                    key.assembly,
                    key.contig,
                    key.position,
                    key.position,
                    key.end()
                ],
                |row| row.get::<_, String>(0),
            )?;
            for row in rows {
                let variant: RootVariant = serde_json::from_str(&row?)?;
                if seen.insert(variant.key.stable_key()) {
                    variants.push(variant);
                }
            }
        }
        variants.sort_by(|left, right| left.key.cmp(&right.key));
        Ok(variants)
    }

    fn root_variant_page(&self, offset: u64, limit: u32) -> Result<Vec<RootVariant>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT payload FROM root_variants
              ORDER BY contig, position, reference, alternate LIMIT ?1 OFFSET ?2",
        )?;
        let rows = statement.query_map(params![limit, offset], |row| row.get::<_, String>(0))?;
        let mut variants = Vec::new();
        for row in rows {
            variants.push(serde_json::from_str(&row?)?);
        }
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

    pub fn save_background_job(&self, job: &BackgroundJob) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT OR REPLACE INTO background_jobs(id, status, updated_at, payload)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                job.id,
                format!("{:?}", job.status),
                job.updated_at.to_rfc3339(),
                serde_json::to_string(job)?,
            ],
        )?;
        Ok(())
    }

    pub fn background_job(&self, job_id: &str) -> Result<BackgroundJob> {
        let connection = self.connection()?;
        let payload: String = connection
            .query_row(
                "SELECT payload FROM background_jobs WHERE id = ?1",
                [job_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| DgwError::Project(format!("unknown background job {job_id}")))?;
        Ok(serde_json::from_str(&payload)?)
    }

    pub fn list_background_jobs(&self, limit: u32) -> Result<Vec<BackgroundJob>> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT payload FROM background_jobs ORDER BY updated_at DESC LIMIT ?1")?;
        let rows = statement.query_map([limit.clamp(1, 200)], |row| row.get::<_, String>(0))?;
        let mut jobs = Vec::new();
        for row in rows {
            jobs.push(serde_json::from_str(&row?)?);
        }
        Ok(jobs)
    }

    /// Preserve the immutable scientific record for a terminal background
    /// job. Hosts may manage execution differently, but provenance is shared.
    pub fn persist_terminal_device_run(&self, job: &BackgroundJob) -> Result<()> {
        let status = match job.status {
            BackgroundJobStatus::Completed => DeviceRunStatus::Completed,
            BackgroundJobStatus::Failed => DeviceRunStatus::Failed,
            BackgroundJobStatus::Cancelled => DeviceRunStatus::Cancelled,
            BackgroundJobStatus::Queued | BackgroundJobStatus::Running => return Ok(()),
        };
        if self.device_run(&job.id).is_ok() {
            return Ok(());
        }
        let input_state_id = job
            .request
            .get("sourceStateId")
            .or_else(|| job.request.get("stateId"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| {
                self.track(&job.track_id)
                    .map(|track| track.head_state_id)
                    .unwrap_or_else(|_| self.manifest.root_state_id.clone())
            });
        let selection = job
            .request
            .get("selection")
            .cloned()
            .filter(|value| !value.is_null())
            .or_else(|| {
                job.request
                    .pointer("/optimizer/selectedVariants")
                    .cloned()
                    .map(|variants| serde_json::json!({"selectedVariants": variants}))
            })
            .unwrap_or_else(|| serde_json::json!({"scope": "captured track state"}));
        let manifest = crate::device::built_in_device_manifest(&job.device_id);
        let device_version = manifest
            .as_ref()
            .map(|manifest| manifest.version.clone())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into());
        let input_fingerprint = job
            .request
            .get("profileInputFingerprint")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or(self.device_run_input_fingerprint(
                &job.device_id,
                &device_version,
                &job.track_id,
                &input_state_id,
                &selection,
                &job.request,
            )?);
        let result_summary = job.result.clone().unwrap_or_else(|| {
            serde_json::json!({
                "stage": job.stage,
                "message": job.message,
                "progress": job.progress,
            })
        });
        let compound_layer_id = result_summary
            .get("compoundLayerId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let output_edit_ids = result_summary
            .get("generatedEditIds")
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let limitation = result_summary
            .get("limitation")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                manifest
                    .as_ref()
                    .map(|manifest| manifest.scientific_limitations.join(" "))
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                "This record preserves the declared device inputs and terminal result; interpretation remains device-specific."
                    .into()
            });
        self.save_device_run(&DeviceRunRecord {
            id: job.id.clone(),
            device_id: job.device_id.clone(),
            device_version,
            operation: job.operation.clone(),
            track_id: job.track_id.clone(),
            input_state_id,
            input_fingerprint,
            selection,
            parameters: job.request.clone(),
            resource_bundle_fingerprint: self.manifest.resource_bundle_fingerprint.clone(),
            resource_context: self.device_run_resource_context(),
            result_summary,
            output_edit_ids,
            compound_layer_id,
            status,
            error: job.error.clone(),
            limitation,
            started_at: job.created_at,
            completed_at: job.updated_at,
        })
    }

    /// Insert one terminal device-run record. Device runs are deliberately
    /// immutable: reusing an id is an error rather than an upsert.
    pub fn save_device_run(&self, run: &DeviceRunRecord) -> Result<()> {
        if run.id.trim().is_empty()
            || run.device_id.trim().is_empty()
            || run.device_version.trim().is_empty()
            || run.track_id.trim().is_empty()
            || run.input_state_id.trim().is_empty()
            || run.input_fingerprint.trim().is_empty()
        {
            return Err(DgwError::Project(
                "device-run identity fields must not be empty".into(),
            ));
        }
        if run.resource_bundle_fingerprint != self.manifest.resource_bundle_fingerprint {
            return Err(DgwError::Project(
                "device run was produced with a different resource bundle".into(),
            ));
        }
        if run.completed_at < run.started_at {
            return Err(DgwError::Project(
                "device run completed before it started".into(),
            ));
        }
        let connection = self.connection()?;
        let state_exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM states WHERE id = ?1)",
            [&run.input_state_id],
            |row| row.get(0),
        )?;
        if !state_exists {
            return Err(DgwError::Project(format!(
                "unknown device-run input state {}",
                run.input_state_id
            )));
        }
        let track_exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?1)",
            [&run.track_id],
            |row| row.get(0),
        )?;
        if !track_exists {
            return Err(DgwError::Project(format!(
                "unknown device-run track {}",
                run.track_id
            )));
        }
        connection
            .execute(
                "INSERT INTO device_runs(id, completed_at, device_id, track_id, input_state_id, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    run.id,
                    run.completed_at.to_rfc3339(),
                    run.device_id,
                    run.track_id,
                    run.input_state_id,
                    serde_json::to_string(run)?,
                ],
            )
            .map_err(|error| match error {
                rusqlite::Error::SqliteFailure(ref failure, _)
                    if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    DgwError::Project(format!(
                        "device run {} already exists and is immutable",
                        run.id
                    ))
                }
                other => other.into(),
            })?;
        Ok(())
    }

    pub fn device_run(&self, run_id: &str) -> Result<DeviceRunRecord> {
        let connection = self.connection()?;
        let payload: String = connection
            .query_row(
                "SELECT payload FROM device_runs WHERE id = ?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| DgwError::Project(format!("unknown device run {run_id}")))?;
        Ok(serde_json::from_str(&payload)?)
    }

    pub fn list_device_runs(&self, limit: u32) -> Result<Vec<DeviceRunRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT payload FROM device_runs ORDER BY completed_at DESC, id DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit.clamp(1, 10_000)], |row| row.get::<_, String>(0))?;
        let mut runs = Vec::new();
        for row in rows {
            runs.push(serde_json::from_str(&row?)?);
        }
        Ok(runs)
    }

    /// Stable hash of the exact invocation inputs, separate from mutable job
    /// progress and terminal messages.
    pub fn device_run_input_fingerprint(
        &self,
        device_id: &str,
        device_version: &str,
        track_id: &str,
        input_state_id: &str,
        selection: &serde_json::Value,
        parameters: &serde_json::Value,
    ) -> Result<String> {
        let payload = serde_json::json!({
            "projectId": self.manifest.project_id,
            "resourceBundleFingerprint": self.manifest.resource_bundle_fingerprint,
            "deviceId": device_id,
            "deviceVersion": device_version,
            "trackId": track_id,
            "inputStateId": input_state_id,
            "selection": selection,
            "parameters": parameters,
        });
        Ok(hex::encode(Sha256::digest(serde_json::to_vec(&payload)?)))
    }

    pub fn device_run_resource_context(&self) -> serde_json::Value {
        serde_json::json!({
            "bundleId": self.manifest.resource_bundle.id,
            "assembly": self.manifest.assembly,
            "bundleFingerprint": self.manifest.resource_bundle_fingerprint,
            "bcftoolsVersion": self.manifest.resource_bundle.bcftools_version,
            "consequenceEngine": "bcftools csq",
            "consequenceAnnotationRelease": self.manifest.resource_bundle.consequence_annotation.as_ref().map(|resource| &resource.release),
            "clinvarRelease": self.manifest.resource_bundle.clinvar.release,
            "cosmicRelease": self.manifest.resource_bundle.cosmic.release,
        })
    }

    /// Remove terminal job-history records without touching queued/running work
    /// or the mutation layers and genome history produced by completed jobs.
    pub fn delete_finished_background_jobs(&self) -> Result<u64> {
        let connection = self.connection()?;
        let deleted = connection.execute(
            "DELETE FROM background_jobs
              WHERE status IN ('Completed', 'Failed', 'Cancelled')",
            [],
        )?;
        Ok(deleted as u64)
    }

    pub fn workstation_session(&self) -> Result<Option<serde_json::Value>> {
        let connection = self.connection()?;
        let payload: Option<String> = connection
            .query_row(
                "SELECT payload FROM workstation_session WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        payload
            .map(|payload| serde_json::from_str(&payload).map_err(DgwError::from))
            .transpose()
    }

    pub fn save_workstation_session(&self, session: &serde_json::Value) -> Result<String> {
        let schema_version = session
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                DgwError::Project("workstation session is missing schemaVersion".into())
            })?;
        if schema_version != 1 {
            return Err(DgwError::Project(format!(
                "unsupported workstation-session schema {schema_version}"
            )));
        }
        if !session.is_object() {
            return Err(DgwError::Project(
                "workstation session must be a JSON object".into(),
            ));
        }
        let payload = serde_json::to_string(session)?;
        if payload.len() > 2 * 1024 * 1024 {
            return Err(DgwError::Project(
                "workstation session exceeds the 2 MiB safety limit".into(),
            ));
        }
        let updated_at = Utc::now().to_rfc3339();
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO workstation_session(singleton, schema_version, updated_at, payload)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(singleton) DO UPDATE SET
               schema_version = excluded.schema_version,
               updated_at = excluded.updated_at,
               payload = excluded.payload",
            params![schema_version, &updated_at, payload],
        )?;
        Ok(updated_at)
    }

    pub fn save_copy(&self, destination: impl AsRef<Path>) -> Result<Project> {
        let destination = destination.as_ref();
        if destination.exists() {
            return Err(DgwError::Project(format!(
                "project destination already exists: {}",
                destination.display()
            )));
        }
        let parent = destination.parent().ok_or_else(|| {
            DgwError::Project("project destination has no parent directory".into())
        })?;
        fs::create_dir_all(parent)?;
        let source_root = self.root.canonicalize()?;
        let destination_parent = parent.canonicalize()?;
        if destination_parent.starts_with(&source_root) {
            return Err(DgwError::Project(
                "a project copy cannot be created inside its source package".into(),
            ));
        }
        let temporary = parent.join(format!(".dgw-copy-{}.tmp", Uuid::new_v4()));
        fs::create_dir(&temporary)?;
        let outcome = (|| -> Result<()> {
            let database_copy = temporary.join(DATABASE_FILE);
            let connection = self.connection()?;
            connection.execute("VACUUM INTO ?1", [database_copy.to_string_lossy().as_ref()])?;

            for directory in ["artifacts", "exports"] {
                let source = self.root.join(directory);
                if source.is_dir() {
                    copy_directory(&source, &temporary.join(directory))?;
                }
            }

            let mut manifest = self.manifest.clone();
            manifest.copied_from_project_id = Some(manifest.project_id.clone());
            manifest.project_id = Uuid::new_v4().to_string();
            manifest.name = destination
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&manifest.name)
                .to_owned();
            manifest.created_at = Utc::now();
            // Keep package-owned files relative so the copied project remains
            // portable if its .dgw directory is moved later.
            let manifest_file = File::create(temporary.join(MANIFEST_FILE))?;
            serde_json::to_writer_pretty(manifest_file, &manifest)?;
            fs::rename(&temporary, destination)?;
            Ok(())
        })();
        if let Err(error) = outcome {
            let _ = fs::remove_dir_all(&temporary);
            return Err(error);
        }
        Project::open(destination)
    }

    /// Persist a device result without attaching it to genome history yet.
    /// Applying the returned layer later is O(1) in visible history size.
    pub fn stage_compound_mutation_layer(
        &self,
        track_id: &str,
        source_state_id: &str,
        device_id: &str,
        position_count: u32,
        changes: &[CompoundMutationChange],
        note: Option<String>,
    ) -> Result<CompoundMutationLayer> {
        let stored = self.stored_track(track_id)?;
        let track = &stored.track;
        if track.read_only {
            return Err(DgwError::Project(
                "the source genome track is read-only; duplicate it before making changes".into(),
            ));
        }
        if track.head_state_id != source_state_id {
            return Err(DgwError::Project(
                "the selected track changed while the bulk preview was being prepared".into(),
            ));
        }
        if changes.is_empty() || position_count == 0 {
            return Err(DgwError::InvalidEdit(
                "a compound mutation layer must contain at least one change".into(),
            ));
        }
        for change in changes {
            if matches!(change.edit, EditKind::CompoundMutationLayer { .. }) {
                return Err(DgwError::InvalidEdit(
                    "compound mutation layers cannot contain another compound layer".into(),
                ));
            }
            validate_edit_shape(&change.edit)?;
        }

        let layer = CompoundMutationLayer {
            id: Uuid::new_v4().to_string(),
            track_id: track_id.into(),
            source_state_id: source_state_id.into(),
            source_bypassed_edit_ids: Some(effective_bypassed_edit_ids(&stored)),
            morph_target: None,
            device_id: device_id.into(),
            position_count,
            change_count: changes.len() as u32,
            note,
            applied_edit_id: None,
            created_at: Utc::now(),
        };
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO compound_mutation_layers(id, track_id, source_state_id, applied_edit_id, payload)
             VALUES (?1, ?2, ?3, NULL, ?4)",
            params![
                layer.id,
                layer.track_id,
                layer.source_state_id,
                serde_json::to_string(&layer)?
            ],
        )?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO compound_mutation_changes(
                   layer_id, ordinal, assembly, contig, position, end_position, payload
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for (ordinal, change) in changes.iter().enumerate() {
                let key = primary_edit_key(&change.edit)?;
                statement.execute(params![
                    layer.id,
                    ordinal as u64,
                    key.assembly,
                    key.contig,
                    key.position,
                    key.end(),
                    serde_json::to_string(change)?
                ])?;
            }
        }
        transaction.commit()?;
        Ok(layer)
    }

    pub fn validate_morph_tracks(&self, source: &GenomeTrack, target: &GenomeTrack) -> Result<()> {
        if source.id == target.id || source.read_only {
            return Err(DgwError::Project(
                "Morph requires an editable source and a different target".into(),
            ));
        }
        for expected in [source, target] {
            let current = self.track(&expected.id)?;
            if current.head_state_id != expected.head_state_id
                || current.bypassed_edit_ids != expected.bypassed_edit_ids
                || current.archived
            {
                return Err(DgwError::Project(
                    "a Morph track changed; preview again".into(),
                ));
            }
        }
        Ok(())
    }

    pub fn stage_morph_layer(
        &self,
        source: &GenomeTrack,
        target: &GenomeTrack,
        position_count: u32,
        changes: &[CompoundMutationChange],
        note: Option<String>,
    ) -> Result<CompoundMutationLayer> {
        self.validate_morph_tracks(source, target)?;
        let mut layer = self.stage_compound_mutation_layer(
            &source.id,
            &source.head_state_id,
            "org.dgw.builtin.genome-morph",
            position_count,
            changes,
            note,
        )?;
        self.validate_morph_tracks(source, target)?;
        layer.morph_target = Some(target.clone());
        self.connection()?.execute(
            "UPDATE compound_mutation_layers SET payload = ?1 WHERE id = ?2",
            params![serde_json::to_string(&layer)?, layer.id],
        )?;
        Ok(layer)
    }

    pub fn compound_mutation_layer(&self, layer_id: &str) -> Result<CompoundMutationLayer> {
        let connection = self.connection()?;
        let payload: String = connection
            .query_row(
                "SELECT payload FROM compound_mutation_layers WHERE id = ?1",
                [layer_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                DgwError::Project(format!("unknown compound mutation layer {layer_id}"))
            })?;
        Ok(serde_json::from_str(&payload)?)
    }

    /// Attach a staged bulk result to its selected track as one reversible
    /// history operation. The source state guard prevents applying stale work.
    pub fn apply_compound_mutation_layer(
        &self,
        track_id: &str,
        layer_id: &str,
    ) -> Result<GenomeState> {
        let mut layer = self.compound_mutation_layer(layer_id)?;
        let mut stored = self.stored_track(track_id)?;
        let original_track_payload = serde_json::to_string(&stored)?;
        if stored.track.read_only {
            return Err(DgwError::Project(
                "the source genome track is read-only; duplicate it before making changes".into(),
            ));
        }
        if layer.track_id != track_id {
            return Err(DgwError::Project(
                "the compound mutation layer belongs to a different genome track".into(),
            ));
        }
        if layer.applied_edit_id.is_some() {
            return Err(DgwError::Project(
                "this compound mutation layer has already been applied".into(),
            ));
        }
        if stored.track.head_state_id != layer.source_state_id {
            return Err(DgwError::Project(
                "the selected track changed after preview; preview the bulk operation again".into(),
            ));
        }

        if layer.source_bypassed_edit_ids.as_ref() != Some(&effective_bypassed_edit_ids(&stored)) {
            return Err(DgwError::Project(
                "the bulk preview has missing or changed bypass state; preview the bulk operation again"
                    .into(),
            ));
        }

        // Loading once here verifies that the normalized child rows are intact.
        let changes = self.compound_layer_changes(layer_id)?;
        if changes.len() != layer.change_count as usize {
            return Err(DgwError::Project(format!(
                "compound mutation layer expected {} changes but stored {}",
                layer.change_count,
                changes.len()
            )));
        }
        let operation_id = Uuid::new_v4().to_string();
        let operation = EditOperation {
            id: operation_id.clone(),
            parent_state_id: stored.track.head_state_id.clone(),
            haplotype: Haplotype::Unphased,
            edit: EditKind::CompoundMutationLayer {
                layer_id: layer.id.clone(),
                position_count: layer.position_count,
                change_count: layer.change_count,
            },
            note: layer.note.clone(),
            created_at: Utc::now(),
        };
        let state_id = hash_text(&format!(
            "{}|{}",
            operation.parent_state_id,
            serde_json::to_string(&operation)?
        ));
        let state = GenomeState {
            id: state_id.clone(),
            parent_id: Some(operation.parent_state_id.clone()),
            edit_id: Some(operation_id.clone()),
            label: None,
            created_at: operation.created_at,
        };
        let mut workspace = self.workspace()?;
        let is_active = workspace.active_track_id == stored.track.id;
        stored.track.head_state_id = state.id.clone();
        stored.track.updated_at = operation.created_at;
        if is_active {
            workspace.current_state_id = state.id.clone();
        }
        layer.applied_edit_id = Some(operation_id.clone());

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if layer.device_id == "org.dgw.builtin.genome-morph" {
            let expected = layer.morph_target.as_ref().ok_or_else(|| {
                DgwError::Project("Morph preview has no captured target; preview again".into())
            })?;
            let current = stored_track_from_connection(&transaction, &expected.id)?.track;
            if current.head_state_id != expected.head_state_id
                || current.bypassed_edit_ids != expected.bypassed_edit_ids
                || current.archived
            {
                return Err(DgwError::Project(
                    "the Morph target changed; preview again".into(),
                ));
            }
        }
        transaction.execute(
            "INSERT INTO states(id, parent_id, edit_id, payload) VALUES (?1, ?2, ?3, ?4)",
            params![
                state.id,
                state.parent_id,
                operation.id,
                serde_json::to_string(&state)?
            ],
        )?;
        transaction.execute(
            "INSERT INTO edits(id, state_id, payload) VALUES (?1, ?2, ?3)",
            params![operation.id, state.id, serde_json::to_string(&operation)?],
        )?;
        let updated_layer = transaction.execute(
            "UPDATE compound_mutation_layers SET applied_edit_id = ?1, payload = ?2
             WHERE id = ?3 AND applied_edit_id IS NULL",
            params![operation_id, serde_json::to_string(&layer)?, layer.id],
        )?;
        if updated_layer == 0 {
            return Err(DgwError::Project(
                "this compound mutation layer was applied by another operation".into(),
            ));
        }
        update_stored_track_if_unchanged(
            &transaction,
            &stored,
            &original_track_payload,
            "preview the bulk operation again",
        )?;
        if is_active {
            transaction.execute(
                "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
                [serde_json::to_string(&workspace)?],
            )?;
        }
        transaction.commit()?;
        Ok(state)
    }

    /// Expand active visible history into allele-copy mutations for Track
    /// Profiler. Compound rows never cross the desktop IPC boundary.
    pub fn active_track_mutations(&self, track_id: &str) -> Result<Vec<TrackMutation>> {
        let track = self.track(track_id)?;
        let bypassed: BTreeSet<&str> = track.bypassed_edit_ids.iter().map(String::as_str).collect();
        let mut mutations = Vec::new();
        for operation in self.edits_for_track(track_id)? {
            if bypassed.contains(operation.id.as_str()) {
                continue;
            }
            match &operation.edit {
                EditKind::CompoundMutationLayer { layer_id, .. } => {
                    for change in self.compound_layer_changes(layer_id)? {
                        if let Some(mutation) =
                            track_mutation_from_edit(&operation.id, change.haplotype, &change.edit)
                        {
                            mutations.push(mutation);
                        }
                    }
                }
                edit => {
                    if let Some(mutation) =
                        track_mutation_from_edit(&operation.id, operation.haplotype, edit)
                    {
                        mutations.push(mutation);
                    }
                }
            }
        }
        Ok(mutations)
    }

    /// Identify the exact scientific inputs aggregated by Track Profiler.
    /// Track identity and edit history IDs are deliberately excluded so an
    /// unchanged duplicate can reuse a compatible profile safely.
    pub fn track_profile_input_fingerprint(
        &self,
        track_id: &str,
        device_ids: &[String],
    ) -> Result<String> {
        let mut devices = device_ids.to_vec();
        devices.sort();
        devices.dedup();
        let mut mutations: Vec<String> = self
            .active_track_mutations(track_id)?
            .into_iter()
            .map(|mutation| {
                serde_json::to_string(&serde_json::json!({
                    "haplotype": mutation.haplotype,
                    "sourceVariant": mutation.source_variant,
                    "currentVariant": mutation.current_variant,
                }))
            })
            .collect::<std::result::Result<_, _>>()?;
        mutations.sort();
        Ok(hash_text(&serde_json::to_string(&serde_json::json!({
            "contract": "dgw-track-profile-input-v1",
            "dgwCoreVersion": env!("CARGO_PKG_VERSION"),
            "resourceBundleFingerprint": self.manifest.resource_bundle_fingerprint,
            "deviceIds": devices,
            "mutations": mutations,
        }))?))
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

    pub fn track(&self, track_id: &str) -> Result<GenomeTrack> {
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
        let mut stored = self.stored_track(track_id)?;
        let original_payload = serde_json::to_string(&stored)?;
        stored.track.name = validated_track_name(name.into())?;
        stored.track.updated_at = Utc::now();
        let connection = self.connection()?;
        update_stored_track_if_unchanged(
            &connection,
            &stored,
            &original_payload,
            "reload the tracks and try again",
        )?;
        Ok(stored.track)
    }

    pub fn delete_track(&self, track_id: &str) -> Result<()> {
        let mut track = self.track(track_id)?;
        if track.read_only {
            return Err(DgwError::Project(
                "the read-only source genome track cannot be deleted".into(),
            ));
        }
        let remaining_tracks: Vec<_> = self
            .list_tracks()?
            .into_iter()
            .filter(|candidate| candidate.id != track.id)
            .collect();

        let mut workspace = self.workspace()?;
        if workspace.active_track_id == track.id {
            let fallback = remaining_tracks
                .iter()
                .find(|candidate| !candidate.read_only)
                .or_else(|| remaining_tracks.first())
                .ok_or_else(|| DgwError::Project("no fallback genome track is available".into()))?;
            workspace.active_track_id = fallback.id.clone();
            workspace.current_state_id = fallback.head_state_id.clone();
            workspace.bypassed_edit_ids = fallback.bypassed_edit_ids.clone();
        }
        track.archived = true;
        track.updated_at = Utc::now();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        update_track(&transaction, &track)?;
        transaction.execute(
            "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
            [serde_json::to_string(&workspace)?],
        )?;
        transaction.commit()?;
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

    fn compound_layer_changes(&self, layer_id: &str) -> Result<Vec<CompoundMutationChange>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT payload FROM compound_mutation_changes
              WHERE layer_id = ?1 ORDER BY ordinal",
        )?;
        let rows = statement.query_map([layer_id], |row| row.get::<_, String>(0))?;
        let mut changes = Vec::new();
        for row in rows {
            changes.push(serde_json::from_str(&row?)?);
        }
        Ok(changes)
    }

    fn compound_layer_changes_in_context(
        &self,
        layer_id: &str,
        context: &FocusContext,
    ) -> Result<Vec<CompoundMutationChange>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT payload FROM compound_mutation_changes
              WHERE layer_id = ?1 AND contig = ?2
                AND position <= ?3 AND end_position >= ?4
              ORDER BY ordinal",
        )?;
        let rows = statement.query_map(
            params![layer_id, context.contig, context.end, context.start],
            |row| row.get::<_, String>(0),
        )?;
        let mut changes = Vec::new();
        for row in rows {
            changes.push(serde_json::from_str(&row?)?);
        }
        Ok(changes)
    }

    fn compound_layer_changes_at_loci(
        &self,
        layer_id: &str,
        keys: &[VariantKey],
    ) -> Result<Vec<CompoundMutationChange>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let loci = VariantLocusIndex::new(keys);
        let mut ranges: BTreeMap<(String, String), (u64, u64)> = BTreeMap::new();
        for key in keys {
            let range = ranges
                .entry((key.assembly.clone(), key.contig.clone()))
                .or_insert((key.position, key.end()));
            range.0 = range.0.min(key.position);
            range.1 = range.1.max(key.end());
        }
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT payload FROM compound_mutation_changes
              WHERE layer_id = ?1 AND assembly = ?2 AND contig = ?3
                AND position <= ?4 AND end_position >= ?5
              ORDER BY ordinal",
        )?;
        let mut changes = Vec::new();
        for ((assembly, contig), (start, end)) in ranges {
            let rows = statement
                .query_map(params![layer_id, assembly, contig, end, start], |row| {
                    row.get::<_, String>(0)
                })?;
            for row in rows {
                let change: CompoundMutationChange = serde_json::from_str(&row?)?;
                if edit_keys(&change.edit)
                    .into_iter()
                    .any(|key| loci.overlaps(key))
                {
                    changes.push(change);
                }
            }
        }
        Ok(changes)
    }

    fn expanded_edits_to_state(&self, state_id: &str) -> Result<Vec<EditOperation>> {
        let operations = self.edits_to_state(state_id)?;
        let mut expanded = Vec::new();
        for operation in operations {
            match &operation.edit {
                EditKind::CompoundMutationLayer { layer_id, .. } => {
                    append_compound_operations(
                        &mut expanded,
                        &operation,
                        self.compound_layer_changes(layer_id)?,
                    );
                }
                _ => expanded.push(operation),
            }
        }
        Ok(expanded)
    }

    fn expanded_edits_to_state_in_context(
        &self,
        state_id: &str,
        context: &FocusContext,
    ) -> Result<Vec<EditOperation>> {
        let operations = self.edits_to_state(state_id)?;
        let mut expanded = Vec::new();
        for operation in operations {
            match &operation.edit {
                EditKind::CompoundMutationLayer { layer_id, .. } => append_compound_operations(
                    &mut expanded,
                    &operation,
                    self.compound_layer_changes_in_context(layer_id, context)?,
                ),
                _ if edit_overlaps_context(&operation.edit, context) => expanded.push(operation),
                _ => {}
            }
        }
        Ok(expanded)
    }

    fn expanded_edits_to_state_at_loci(
        &self,
        state_id: &str,
        keys: &[VariantKey],
    ) -> Result<Vec<EditOperation>> {
        let loci = VariantLocusIndex::new(keys);
        let operations = self.edits_to_state(state_id)?;
        let mut expanded = Vec::new();
        for operation in operations {
            match &operation.edit {
                EditKind::CompoundMutationLayer { layer_id, .. } => append_compound_operations(
                    &mut expanded,
                    &operation,
                    self.compound_layer_changes_at_loci(layer_id, keys)?,
                ),
                _ if edit_keys(&operation.edit)
                    .into_iter()
                    .any(|key| loci.overlaps(key)) =>
                {
                    expanded.push(operation)
                }
                _ => {}
            }
        }
        Ok(expanded)
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
            &self.expanded_edits_to_state(state_id)?,
            bypassed_edit_ids,
        )
    }

    pub fn effective_variants_for_track(&self, track_id: &str) -> Result<Vec<EffectiveVariant>> {
        let stored = self.stored_track(track_id)?;
        let bypassed_edit_ids = effective_bypassed_edit_ids(&stored);
        self.effective_variants(&stored.track.head_state_id, &bypassed_edit_ids)
    }

    fn effective_variants_in_context(
        &self,
        state_id: &str,
        bypassed_edit_ids: &[String],
        context: &FocusContext,
    ) -> Result<Vec<EffectiveVariant>> {
        let roots = self.root_variants_in_context(context, None, 0)?;
        let operations = self.expanded_edits_to_state_in_context(state_id, context)?;
        let mut variants = effective_variants(&roots, &operations, bypassed_edit_ids)?;
        variants.retain(|variant| variant_overlaps_context(&variant.key, context));
        Ok(variants)
    }

    pub fn effective_variants_for_track_in_context(
        &self,
        track_id: &str,
        context: &FocusContext,
    ) -> Result<Vec<EffectiveVariant>> {
        let stored = self.stored_track(track_id)?;
        self.effective_variants_in_context(
            &stored.track.head_state_id,
            &effective_bypassed_edit_ids(&stored),
            context,
        )
    }

    fn effective_variants_at_loci(
        &self,
        state_id: &str,
        bypassed_edit_ids: &[String],
        keys: &[VariantKey],
    ) -> Result<Vec<EffectiveVariant>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let loci = VariantLocusIndex::new(keys);
        let roots = self.root_variants_at_loci(keys)?;
        let operations = self.expanded_edits_to_state_at_loci(state_id, keys)?;
        let mut variants = effective_variants(&roots, &operations, bypassed_edit_ids)?;
        variants.retain(|variant| loci.overlaps(&variant.key));
        Ok(variants)
    }

    pub fn effective_variants_for_track_at_loci(
        &self,
        track_id: &str,
        keys: &[VariantKey],
    ) -> Result<Vec<EffectiveVariant>> {
        let stored = self.stored_track(track_id)?;
        self.effective_variants_at_loci(
            &stored.track.head_state_id,
            &effective_bypassed_edit_ids(&stored),
            keys,
        )
    }

    pub fn source_variants_at_loci(&self, keys: &[VariantKey]) -> Result<Vec<EffectiveVariant>> {
        self.effective_variants_at_loci(&self.manifest.root_state_id, &[], keys)
    }

    pub fn variant_page(&self, track_id: &str, offset: u64, limit: u32) -> Result<VariantPage> {
        let limit = limit.clamp(1, VARIANT_PAGE_SIZE);
        let roots = self.root_variant_page(offset, limit)?;
        let keys: Vec<VariantKey> = roots.iter().map(|variant| variant.key.clone()).collect();
        let variants = self.effective_variants_for_track_at_loci(track_id, &keys)?;
        let total = self.root_variant_count()?;
        Ok(VariantPage {
            track_id: track_id.into(),
            offset,
            limit,
            total,
            has_more: offset.saturating_add(u64::from(limit)) < total,
            variants,
        })
    }

    pub fn track_comparison_page(
        &self,
        track_id: &str,
        offset: u64,
        limit: u32,
    ) -> Result<TrackComparisonPage> {
        let stored = self.stored_track(track_id)?;
        let bypassed = effective_bypassed_edit_ids(&stored);
        let revision = hash_text(&serde_json::to_string(&(
            &stored.track.head_state_id,
            &bypassed,
        ))?);
        let limit = limit.clamp(1, VARIANT_PAGE_SIZE);
        let connection = self.connection()?;
        let total_loci: u64 = connection.query_row(
            "SELECT COUNT(*) FROM (SELECT contig, position, reference FROM root_variants GROUP BY contig, position, reference)", [], |row| row.get(0))?;
        let mut statement = connection.prepare(
            "SELECT contig, position, reference, MIN(alternate) FROM root_variants
             GROUP BY contig, position, reference ORDER BY contig, position, reference LIMIT ?1 OFFSET ?2")?;
        let keys = statement
            .query_map(params![limit, offset], |row| {
                Ok(VariantKey {
                    assembly: self.manifest.resource_bundle.assembly.clone(),
                    contig: row.get(0)?,
                    position: row.get(1)?,
                    reference: row.get(2)?,
                    alternate: row.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let source = self.source_variants_at_loci(&keys)?;
        let current =
            self.effective_variants_at_loci(&stored.track.head_state_id, &bypassed, &keys)?;
        let rows = keys
            .into_iter()
            .map(|key| {
                let at_locus = |v: &&EffectiveVariant| {
                    v.key.contig == key.contig
                        && v.key.position == key.position
                        && v.key.reference == key.reference
                };
                let before: Vec<_> = source.iter().filter(at_locus).cloned().collect();
                let after: Vec<_> = current.iter().filter(at_locus).cloned().collect();
                let signature = |variants: &[EffectiveVariant]| {
                    variants
                        .iter()
                        .map(|v| {
                            (
                                v.key.stable_key(),
                                v.haplotype1_alt,
                                v.haplotype2_alt,
                                v.unphased_alt,
                                v.unphased_slot,
                            )
                        })
                        .collect::<BTreeSet<_>>()
                };
                TrackComparisonLocus {
                    contig: key.contig,
                    position: key.position,
                    reference: key.reference,
                    changed: signature(&before) != signature(&after),
                    source: before,
                    current: after,
                }
            })
            .collect();
        let latest = self.stored_track(track_id)?;
        if latest.track.head_state_id != stored.track.head_state_id
            || effective_bypassed_edit_ids(&latest) != bypassed
        {
            return Err(DgwError::Project(
                "track changed while comparing; reload the page".into(),
            ));
        }
        Ok(TrackComparisonPage {
            track_id: track_id.into(),
            revision,
            offset,
            limit,
            total_loci,
            has_more: offset.saturating_add(u64::from(limit)) < total_loci,
            rows,
        })
    }

    pub fn variant_contig_summaries(&self) -> Result<Vec<VariantContigSummary>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT contig, COUNT(*), MIN(position), MAX(end_position)
               FROM root_variants
              GROUP BY contig",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(VariantContigSummary {
                contig: row.get(0)?,
                total: row.get(1)?,
                min_position: row.get(2)?,
                max_position: row.get(3)?,
            })
        })?;
        let mut summaries = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        summaries.sort_by(|left, right| contig_rank(&left.contig).cmp(&contig_rank(&right.contig)));
        Ok(summaries)
    }

    pub fn variant_navigation_bins(
        &self,
        contig: &str,
        requested_bins: u32,
    ) -> Result<Vec<VariantNavigationBin>> {
        self.variant_navigation_bins_in_region(contig, None, None, requested_bins)
    }

    pub fn variant_navigation_bins_in_region(
        &self,
        contig: &str,
        region_start: Option<u64>,
        region_end: Option<u64>,
        requested_bins: u32,
    ) -> Result<Vec<VariantNavigationBin>> {
        if matches!(
            (region_start, region_end),
            (Some(_), None) | (None, Some(_))
        ) || matches!((region_start, region_end), (Some(start), Some(end)) if start == 0 || end < start)
        {
            return Err(DgwError::Project(
                "variant navigation region must be a valid 1-based inclusive interval".into(),
            ));
        }
        let bins = requested_bins.clamp(1, 32);
        let connection = self.connection()?;
        let (minimum, maximum, total): (Option<u64>, Option<u64>, u64) = connection.query_row(
            "SELECT MIN(position), MAX(end_position), COUNT(*)
               FROM root_variants
              WHERE contig = ?1
                AND (?2 IS NULL OR position >= ?2)
                AND (?3 IS NULL OR position <= ?3)",
            params![contig, region_start, region_end],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let (Some(minimum), Some(maximum)) = (minimum, maximum) else {
            return Ok(Vec::new());
        };
        let span = maximum.saturating_sub(minimum).saturating_add(1);
        let bins = bins
            .min(total.min(u64::from(u32::MAX)) as u32)
            .min(span.min(u64::from(u32::MAX)) as u32)
            .max(1);
        let mut statement = connection.prepare(
            "SELECT MIN(?6 - 1, ((position - ?4) * ?6) / ?5) AS bin,
                    COUNT(*), MIN(position), MAX(end_position)
               FROM root_variants
              WHERE contig = ?1
                AND (?2 IS NULL OR position >= ?2)
                AND (?3 IS NULL OR position <= ?3)
              GROUP BY bin ORDER BY bin",
        )?;
        let rows = statement.query_map(
            params![contig, region_start, region_end, minimum, span, bins],
            |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, u64>(3)?,
                ))
            },
        )?;
        let mut navigation = Vec::new();
        for row in rows {
            let (_index, count, start, end) = row?;
            navigation.push(VariantNavigationBin {
                contig: contig.into(),
                start,
                end: end.max(start),
                total: count,
            });
        }
        Ok(navigation)
    }

    pub fn variant_density(&self, track_id: &str, context: FocusContext) -> Result<VariantDensity> {
        self.track(track_id)?;
        if context.start == 0 || context.end < context.start {
            return Err(DgwError::Project(
                "density context must be a valid 1-based inclusive interval".into(),
            ));
        }
        let span = context.end - context.start + 1;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT MIN(?4 - 1, ((position - ?2) * ?4) / ?5) AS bin, COUNT(*)
               FROM root_variants
              WHERE contig = ?1 AND position BETWEEN ?2 AND ?3
              GROUP BY bin ORDER BY bin",
        )?;
        let rows = statement.query_map(
            params![
                context.contig,
                context.start,
                context.end,
                VARIANT_DENSITY_BINS,
                span
            ],
            |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u64>(1)?)),
        )?;
        let mut counts = vec![0_u64; VARIANT_DENSITY_BINS as usize];
        for row in rows {
            let (index, count) = row?;
            if let Some(bin) = counts.get_mut(index as usize) {
                *bin = count;
            }
        }
        let mut bins = Vec::with_capacity(VARIANT_DENSITY_BINS as usize);
        for (index, count) in counts.into_iter().enumerate() {
            let start = context.start + span * index as u64 / u64::from(VARIANT_DENSITY_BINS);
            let end = if index + 1 == VARIANT_DENSITY_BINS as usize {
                context.end
            } else {
                context.start + span * (index as u64 + 1) / u64::from(VARIANT_DENSITY_BINS) - 1
            };
            bins.push(VariantDensityBin {
                contig: context.contig.clone(),
                start,
                end: end.max(start),
                count,
            });
        }
        let total = bins.iter().map(|bin| bin.count).sum();
        Ok(VariantDensity {
            track_id: track_id.into(),
            context,
            total,
            bins,
        })
    }

    pub fn resolve_selection(
        &self,
        selection: &VariantSelection,
        limit: u32,
    ) -> Result<SelectionResolution> {
        let limit = limit.max(1);
        let (track_id, exclusions, candidates, total_hint) = match selection {
            VariantSelection::Explicit { track_id, variants } => {
                let effective = self.effective_variants_for_track_at_loci(track_id, variants)?;
                let requested: BTreeSet<String> =
                    variants.iter().map(VariantKey::stable_key).collect();
                let candidates: Vec<VariantKey> = effective
                    .into_iter()
                    .filter(|variant| requested.contains(&variant.key.stable_key()))
                    .map(|variant| variant.key)
                    .collect();
                let total = candidates.len() as u64;
                (track_id.clone(), Vec::new(), candidates, total)
            }
            VariantSelection::Interval {
                track_id,
                contig,
                start,
                end,
                exclusions,
            } => {
                let context = FocusContext {
                    contig: contig.clone(),
                    start: *start,
                    end: *end,
                };
                if context.start == 0 || context.end < context.start {
                    return Err(DgwError::Project(
                        "selection interval must be a valid 1-based inclusive interval".into(),
                    ));
                }
                let roots = self.root_variants_in_context(
                    &context,
                    Some(limit as usize + exclusions.len() + 1),
                    0,
                )?;
                let keys: Vec<VariantKey> = roots.into_iter().map(|variant| variant.key).collect();
                let candidates = self
                    .effective_variants_for_track_at_loci(track_id, &keys)?
                    .into_iter()
                    .map(|variant| variant.key)
                    .collect();
                (
                    track_id.clone(),
                    exclusions.clone(),
                    candidates,
                    self.source_variant_count_in_context(&context)?,
                )
            }
            VariantSelection::AllTrack {
                track_id,
                exclusions,
            } => {
                self.track(track_id)?;
                let fetch_limit = limit
                    .saturating_add(exclusions.len().min(u32::MAX as usize) as u32)
                    .saturating_add(1);
                let keys: Vec<VariantKey> = self
                    .root_variant_page(0, fetch_limit)?
                    .into_iter()
                    .map(|variant| variant.key)
                    .collect();
                let candidates = self
                    .effective_variants_for_track_at_loci(track_id, &keys)?
                    .into_iter()
                    .map(|variant| variant.key)
                    .collect();
                (
                    track_id.clone(),
                    exclusions.clone(),
                    candidates,
                    self.root_variant_count()?,
                )
            }
        };
        let excluded: BTreeSet<String> = exclusions.iter().map(VariantKey::stable_key).collect();
        let mut seen = BTreeSet::new();
        let mut variants: Vec<VariantKey> = candidates
            .into_iter()
            .filter(|key| !excluded.contains(&key.stable_key()))
            .filter(|key| seen.insert(key.stable_key()))
            .collect();
        variants.sort();
        let total = if total_hint == 0 {
            variants.len() as u64
        } else {
            total_hint.saturating_sub(exclusions.len() as u64)
        };
        let truncated = variants.len() > limit as usize || total > u64::from(limit);
        variants.truncate(limit as usize);
        Ok(SelectionResolution {
            track_id,
            total,
            limit,
            variants,
            truncated,
        })
    }

    /// Resolve, plan, and optionally stage a Mutation Generator preview using
    /// one shared contract for desktop and agent hosts.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_randomizer_preview(
        &self,
        track_id: &str,
        expected_head_state_id: &str,
        mut request: RandomizerRequest,
        selection: Option<&VariantSelection>,
        selection_limit: Option<u32>,
        stage_compound_layer: bool,
    ) -> Result<RandomizerPreviewResult> {
        let track = self.track(track_id)?;
        if track.read_only {
            return Err(DgwError::Project(
                "the source genome track is read-only; duplicate it before making changes".into(),
            ));
        }
        if track.head_state_id != expected_head_state_id {
            return Err(DgwError::Project(
                "the selected track changed while the Mutation Generator preview was being prepared"
                    .into(),
            ));
        }
        if let Some(selection) = selection {
            let limit = selection_limit
                .unwrap_or(MAX_RANDOMIZER_POSITIONS as u32)
                .clamp(1, MAX_RANDOMIZER_POSITIONS as u32);
            let resolution = self.resolve_selection(selection, limit)?;
            if resolution.track_id != track_id {
                return Err(DgwError::Project(
                    "Mutation Generator selection belongs to a different track".into(),
                ));
            }
            if resolution.truncated {
                return Err(DgwError::InvalidEdit(format!(
                    "{} alleles are selected; Mutation Generator accepts at most {} positions per run",
                    resolution.total, limit
                )));
            }
            request.selected_variants = resolution.variants;
        }
        let current =
            self.effective_variants_for_track_at_loci(track_id, &request.selected_variants)?;
        let plan = plan_randomizer(&current, &request)?;
        let after_planning = self.track(track_id)?;
        if after_planning.head_state_id != track.head_state_id
            || after_planning.bypassed_edit_ids != track.bypassed_edit_ids
        {
            return Err(DgwError::Project(
                "the selected track changed during Mutation Generator planning; preview again"
                    .into(),
            ));
        }
        let mut preview = compact_randomizer_preview(&plan);
        if stage_compound_layer && !plan.proposals.is_empty() {
            let note = format!(
                "Mutation Generator · Randomizer · {} · seed {} · amount {}% · {} positions",
                request.substitution_pattern.label(),
                request.seed,
                request.amount,
                plan.randomized_positions
            );
            let changes: Vec<_> = plan
                .proposals
                .iter()
                .map(|proposal| CompoundMutationChange {
                    haplotype: proposal.haplotype,
                    edit: proposal.edit.clone(),
                })
                .collect();
            let layer = self.stage_compound_mutation_layer(
                track_id,
                expected_head_state_id,
                "org.dgw.builtin.mutation-generator",
                plan.randomized_positions,
                &changes,
                Some(note),
            )?;
            preview.compound_layer_id = Some(layer.id);
        }
        Ok(preview)
    }

    /// Resolve one transport target while keeping the desktop payload bounded.
    /// The current implementation builds only a compact key list in Rust; the
    /// complete allele payload never crosses IPC.
    pub fn transport_target(
        &self,
        request: &TransportTargetRequest,
    ) -> Result<TransportTargetResult> {
        let track_id = match &request.selection {
            VariantSelection::Explicit { track_id, .. }
            | VariantSelection::Interval { track_id, .. }
            | VariantSelection::AllTrack { track_id, .. } => track_id,
        };
        let track = self.track(track_id)?;
        let excluded: BTreeSet<String> = match &request.selection {
            VariantSelection::Explicit { .. } => BTreeSet::new(),
            VariantSelection::Interval { exclusions, .. }
            | VariantSelection::AllTrack { exclusions, .. } => {
                exclusions.iter().map(VariantKey::stable_key).collect()
            }
        };
        let in_scope = |key: &VariantKey| -> bool {
            if excluded.contains(&key.stable_key()) {
                return false;
            }
            match &request.selection {
                VariantSelection::Explicit { variants, .. } => variants
                    .iter()
                    .any(|candidate| candidate.stable_key() == key.stable_key()),
                VariantSelection::Interval {
                    contig, start, end, ..
                } => key.contig == *contig && key.position <= *end && key.end() >= *start,
                VariantSelection::AllTrack { .. } => true,
            }
        };

        let mut candidates: Vec<(VariantKey, Option<String>)> = match request.target_kind {
            TransportTargetKind::Variants => self
                .transport_source_keys(&request.selection)?
                .into_iter()
                .filter(&in_scope)
                .map(|key| (key, None))
                .collect(),
            TransportTargetKind::ActiveEdits => {
                let bypassed: BTreeSet<&str> =
                    track.bypassed_edit_ids.iter().map(String::as_str).collect();
                self.active_track_mutations(track_id)?
                    .into_iter()
                    .filter(|mutation| !bypassed.contains(mutation.edit_id.as_str()))
                    .filter(|mutation| in_scope(&mutation.source_variant))
                    .map(|mutation| (mutation.source_variant, Some(mutation.edit_id)))
                    .collect()
            }
        };
        candidates.sort_by(|left, right| {
            contig_rank(&left.0.contig)
                .cmp(&contig_rank(&right.0.contig))
                .then_with(|| left.0.position.cmp(&right.0.position))
                .then_with(|| left.0.reference.cmp(&right.0.reference))
                .then_with(|| left.0.alternate.cmp(&right.0.alternate))
                .then_with(|| left.1.cmp(&right.1))
        });
        candidates.dedup_by(|left, right| left.0 == right.0 && left.1 == right.1);
        let total = candidates.len() as u64;
        if candidates.is_empty() {
            return Ok(TransportTargetResult {
                target: None,
                total,
            });
        }

        let locate = request.cursor.as_ref().and_then(|cursor| {
            candidates.iter().position(|(key, edit_id)| {
                key == &cursor.source_key
                    && (request.target_kind == TransportTargetKind::Variants
                        || cursor.edit_id.as_ref() == edit_id.as_ref())
            })
        });
        let (index, wrapped) = match request.action {
            TransportAction::First => (0, false),
            TransportAction::Last => (candidates.len() - 1, false),
            TransportAction::Locate => (locate.unwrap_or(0), false),
            TransportAction::Next => match locate {
                Some(index) if index + 1 < candidates.len() => (index + 1, false),
                Some(_) if request.wrap => (0, true),
                Some(index) => (index, false),
                None => (0, false),
            },
            TransportAction::Previous => match locate {
                Some(index) if index > 0 => (index - 1, false),
                Some(_) if request.wrap => (candidates.len() - 1, true),
                Some(index) => (index, false),
                None => (candidates.len() - 1, false),
            },
        };
        let (source_key, edit_id) = candidates[index].clone();
        let current_variant = self
            .effective_variants_for_track_at_loci(track_id, std::slice::from_ref(&source_key))?
            .into_iter()
            .find(|variant| {
                variant.source_key.as_ref() == Some(&source_key) || variant.key == source_key
            });
        let cursor = TransportCursor {
            source_key: source_key.clone(),
            edit_id: edit_id.clone(),
            compound_ordinal: None,
        };
        Ok(TransportTargetResult {
            target: Some(TransportTarget {
                cursor,
                source_key,
                locus_status: if current_variant.is_some() {
                    "alternate".into()
                } else {
                    "reference".into()
                },
                current_variant,
                edit_id,
                ordinal: index as u64 + 1,
                total,
                wrapped,
            }),
            total,
        })
    }

    fn transport_source_keys(&self, selection: &VariantSelection) -> Result<Vec<VariantKey>> {
        if let VariantSelection::Explicit { variants, .. } = selection {
            return Ok(variants.clone());
        }
        let connection = self.connection()?;
        let (sql, contig, start, end) = match selection {
            VariantSelection::Interval {
                contig, start, end, ..
            } => (
                "SELECT assembly, contig, position, reference, alternate FROM root_variants
                  WHERE contig = ?1 AND position <= ?2 AND end_position >= ?3",
                Some(contig.as_str()),
                Some(*end),
                Some(*start),
            ),
            VariantSelection::AllTrack { .. } => (
                "SELECT assembly, contig, position, reference, alternate FROM root_variants
                  WHERE ?1 IS NULL AND ?2 IS NULL AND ?3 IS NULL",
                None,
                None,
                None,
            ),
            VariantSelection::Explicit { .. } => unreachable!(),
        };
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map(params![contig, start, end], |row| {
            Ok(VariantKey {
                assembly: row.get(0)?,
                contig: row.get(1)?,
                position: row.get(2)?,
                reference: row.get(3)?,
                alternate: row.get(4)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(DgwError::from)
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

    /// Validate an interactive allele edit without changing the project.
    /// Set-allele edits are normalized with the project's pinned bcftools and
    /// reference before their state transition is projected.
    pub fn preview_allele_edit(
        &self,
        track_id: &str,
        expected_head_state_id: &str,
        haplotype: Haplotype,
        edit: EditKind,
    ) -> Result<AlleleEditPreview> {
        let stored = self.stored_track(track_id)?;
        if stored.track.read_only {
            return Err(DgwError::Project(
                "the source genome track is read-only; duplicate it before making changes".into(),
            ));
        }
        if stored.track.head_state_id != expected_head_state_id {
            return Err(DgwError::Project(format!(
                "track {} changed after the edit was prepared; preview it again",
                stored.track.id
            )));
        }
        let edit = match edit {
            EditKind::SetAllele {
                key,
                source_key,
                unphased_slot,
            } => EditKind::SetAllele {
                key: crate::evaluation::normalize_variant(&self.manifest.resource_bundle, &key)?,
                source_key,
                unphased_slot,
            },
            EditKind::RestoreReference { source_key } => EditKind::RestoreReference { source_key },
            EditKind::CompoundMutationLayer { .. } => {
                return Err(DgwError::InvalidEdit(
                    "manual allele preview does not accept compound mutation layers".into(),
                ));
            }
        };
        validate_edit_shape(&edit)?;
        let context = context_for_edit(&edit)?;
        let effective_bypasses = effective_bypassed_edit_ids(&stored);
        let effective_before = self.effective_variants_in_context(
            &stored.track.head_state_id,
            &effective_bypasses,
            &context,
        )?;
        validate_no_overlap(&effective_before, haplotype, &edit)?;
        let preview_id = hash_text(&serde_json::to_string(&(
            &self.manifest.project_id,
            &stored.track.id,
            expected_head_state_id,
            &stored.track.bypassed_edit_ids,
            haplotype,
            &edit,
        ))?);
        let mut operations =
            self.expanded_edits_to_state_in_context(expected_head_state_id, &context)?;
        operations.push(EditOperation {
            id: preview_id.clone(),
            parent_state_id: expected_head_state_id.into(),
            haplotype,
            edit: edit.clone(),
            note: None,
            created_at: Utc::now(),
        });
        let effective_after = effective_variants(
            &self.root_variants_in_context(&context, None, 0)?,
            &operations,
            &effective_bypasses,
        )?;
        Ok(AlleleEditPreview {
            id: preview_id,
            project_id: self.manifest.project_id.clone(),
            track_id: stored.track.id,
            track_name: stored.track.name,
            expected_head_state_id: expected_head_state_id.into(),
            haplotype,
            edit,
            context,
            effective_before,
            effective_after,
        })
    }

    /// Apply exactly the edit represented by a fresh preview.
    pub fn apply_previewed_allele_edit(
        &self,
        track_id: &str,
        expected_head_state_id: &str,
        preview_id: &str,
        haplotype: Haplotype,
        edit: EditKind,
        note: Option<String>,
    ) -> Result<(AlleleEditPreview, GenomeState)> {
        let preview =
            self.preview_allele_edit(track_id, expected_head_state_id, haplotype, edit)?;
        if preview.id != preview_id {
            return Err(DgwError::Project(
                "the allele edit does not match its preview; preview it again".into(),
            ));
        }
        let stored = self.stored_track(track_id)?;
        if stored.track.head_state_id != expected_head_state_id {
            return Err(DgwError::Project(format!(
                "track {track_id} changed after the edit was previewed; preview it again"
            )));
        }
        let state =
            self.apply_edit_to_track_from(stored, haplotype, preview.edit.clone(), note, None)?;
        Ok((preview, state))
    }

    /// Desktop convenience path: validate, normalize, and apply against an
    /// explicit track head in one call.
    pub fn apply_allele_edit_at_head(
        &self,
        track_id: &str,
        expected_head_state_id: &str,
        haplotype: Haplotype,
        edit: EditKind,
        note: Option<String>,
    ) -> Result<GenomeState> {
        let preview =
            self.preview_allele_edit(track_id, expected_head_state_id, haplotype, edit)?;
        let stored = self.stored_track(track_id)?;
        if stored.track.head_state_id != expected_head_state_id {
            return Err(DgwError::Project(format!(
                "track {track_id} changed after the edit was prepared; try again"
            )));
        }
        self.apply_edit_to_track_from(stored, haplotype, preview.edit, note, None)
    }

    /// Validate and persist a generated edit batch as one SQLite transaction.
    /// Either every state/edit row is committed, or the track is unchanged.
    pub fn apply_edits_to_track(
        &self,
        track_id: &str,
        edits: &[(Haplotype, EditKind, Option<String>)],
    ) -> Result<Vec<GenomeState>> {
        if edits.is_empty() {
            return Ok(Vec::new());
        }
        let mut stored = self.stored_track(track_id)?;
        if stored.track.read_only {
            return Err(DgwError::Project(
                "the source genome track is read-only; duplicate it before making changes".into(),
            ));
        }
        let mut effective_bypasses = stored.baseline_bypassed_edit_ids.clone();
        append_unique(&mut effective_bypasses, &stored.track.bypassed_edit_ids);

        let mut locus_keys = Vec::new();
        for (_, edit, _) in edits {
            validate_edit_shape(edit)?;
            locus_keys.extend(edit_keys(edit).into_iter().cloned());
        }
        let roots = self.root_variants_at_loci(&locus_keys)?;
        let mut operations =
            self.expanded_edits_to_state_at_loci(&stored.track.head_state_id, &locus_keys)?;
        let mut parent_state_id = stored.track.head_state_id.clone();
        let mut states = Vec::with_capacity(edits.len());
        let mut new_operations = Vec::with_capacity(edits.len());

        for (haplotype, edit, note) in edits {
            let current = effective_variants(&roots, &operations, &effective_bypasses)?;
            validate_no_overlap(&current, *haplotype, edit)?;
            let operation = EditOperation {
                id: Uuid::new_v4().to_string(),
                parent_state_id: parent_state_id.clone(),
                haplotype: *haplotype,
                edit: edit.clone(),
                note: note.clone(),
                created_at: Utc::now(),
            };
            operations.push(operation.clone());
            effective_variants(&roots, &operations, &effective_bypasses)?;
            let state_id = hash_text(&format!(
                "{}|{}",
                operation.parent_state_id,
                serde_json::to_string(&operation)?
            ));
            let state = GenomeState {
                id: state_id.clone(),
                parent_id: Some(operation.parent_state_id.clone()),
                edit_id: Some(operation.id.clone()),
                label: None,
                created_at: operation.created_at,
            };
            parent_state_id = state_id;
            states.push(state);
            new_operations.push(operation);
        }

        let mut workspace = self.workspace()?;
        let is_active = workspace.active_track_id == stored.track.id;
        stored.track.head_state_id = parent_state_id;
        stored.track.updated_at = states
            .last()
            .map(|state| state.created_at)
            .unwrap_or_else(Utc::now);
        if is_active {
            workspace.current_state_id = stored.track.head_state_id.clone();
            workspace.bypassed_edit_ids = stored.track.bypassed_edit_ids.clone();
        }

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        for (state, operation) in states.iter().zip(new_operations.iter()) {
            transaction.execute(
                "INSERT INTO states(id, parent_id, edit_id, payload) VALUES (?1, ?2, ?3, ?4)",
                params![
                    state.id,
                    state.parent_id,
                    operation.id,
                    serde_json::to_string(state)?
                ],
            )?;
            transaction.execute(
                "INSERT INTO edits(id, state_id, payload) VALUES (?1, ?2, ?3)",
                params![operation.id, state.id, serde_json::to_string(operation)?],
            )?;
        }
        update_stored_track(&transaction, &stored)?;
        if is_active {
            transaction.execute(
                "UPDATE workspace SET payload = ?1 WHERE singleton = 1",
                [serde_json::to_string(&workspace)?],
            )?;
        }
        transaction.commit()?;
        Ok(states)
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
        let original_payload = serde_json::to_string(&stored)?;
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
        let edit_context = context_for_edit(&edit)?;
        let effective = self.effective_variants_in_context(
            &stored.track.head_state_id,
            &effective_bypasses,
            &edit_context,
        )?;
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
        let mut candidate_operations =
            self.expanded_edits_to_state_in_context(&stored.track.head_state_id, &edit_context)?;
        candidate_operations.push(operation.clone());
        effective_variants(
            &self.root_variants_in_context(&edit_context, None, 0)?,
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
        update_stored_track_if_unchanged(
            &transaction,
            &stored,
            &original_payload,
            "preview it again",
        )?;
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

    pub fn toggle_track_edits_bypass(
        &self,
        track_id: &str,
        changed_edit_ids: &[String],
        bypassed: bool,
    ) -> Result<GenomeTrack> {
        let track = self.track(track_id)?;
        let changed: BTreeSet<&str> = changed_edit_ids.iter().map(String::as_str).collect();
        let mut edit_ids = track.bypassed_edit_ids.clone();
        if bypassed {
            for edit_id in changed_edit_ids {
                if !edit_ids.contains(edit_id) {
                    edit_ids.push(edit_id.clone());
                }
            }
        } else {
            edit_ids.retain(|edit_id| !changed.contains(edit_id.as_str()));
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
        let variant_count = self.root_variant_count()?;
        let mut variants = match &workspace.focus {
            Some(context) => self.effective_variants_in_context(
                &active_track.head_state_id,
                &effective_bypassed_edit_ids(&active_stored),
                context,
            )?,
            None => {
                let roots = self.root_variant_page(0, 1)?;
                let keys: Vec<VariantKey> = roots.into_iter().map(|variant| variant.key).collect();
                self.effective_variants_at_loci(
                    &active_track.head_state_id,
                    &effective_bypassed_edit_ids(&active_stored),
                    &keys,
                )?
            }
        };
        variants.truncate(MAX_TRACK_REGION_VARIANTS);
        let connection = self.connection()?;
        let mut warning_statement = connection.prepare(
            "SELECT message FROM warnings
             ORDER BY CASE
               WHEN message LIKE 'DGW excluded % non-PASS %' THEN 0
               WHEN message LIKE 'DGW normalized %' THEN 1
               ELSE 2
             END, message",
        )?;
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
        if context.start == 0 || context.end < context.start {
            return Err(DgwError::Project(
                "focus must be a valid 1-based reference interval".into(),
            ));
        }
        let workspace = self.workspace()?;
        let active_stored = self.stored_track(&workspace.active_track_id)?;
        let active_track = active_stored.track.clone();
        let span = context.end - context.start + 1;
        let source_variant_total = self.source_variant_count_in_context(&context)?;
        let detailed = source_variant_total <= MAX_TRACK_REGION_VARIANTS as u64;
        let variants = if detailed {
            self.effective_variants_in_context(
                &active_track.head_state_id,
                &effective_bypassed_edit_ids(&active_stored),
                &context,
            )?
        } else {
            Vec::new()
        };
        let mut warnings = Vec::new();
        let sequence_detail = detailed && span <= MAX_SEQUENCE_FOCUS_BASES;
        let reference_sequence = if sequence_detail {
            match self.fetch_reference(&context) {
                Ok(sequence) => Some(sequence),
                Err(error) => {
                    warnings.push(format!("Reference sequence unavailable: {error}"));
                    None
                }
            }
        } else {
            None
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
        if !detailed {
            warnings.push(format!(
                "This interval contains {source_variant_total} source alleles. Track View is using density mode; zoom in to inspect individual alleles."
            ));
        } else if !sequence_detail {
            warnings.push(format!(
                "This interval spans {span} bases. Individual alleles remain available, but reference and genome-copy sequences appear only at 50 kb or less."
            ));
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
        let stored = self.stored_track(track_id)?;
        self.export_focus_fasta_for_track(&stored, context, output_path)
    }

    /// Export a bounded FASTA only when the caller's explicit track view is
    /// still current. This is the safe command boundary used by agent clients.
    pub fn export_focus_fasta_at_head(
        &self,
        track_id: &str,
        expected_head_state_id: &str,
        expected_bypassed_edit_ids: &[String],
        context: FocusContext,
        output_path: impl AsRef<Path>,
    ) -> Result<FocusFastaExport> {
        let stored = self.stored_track(track_id)?;
        ensure_track_export_state(&stored, expected_head_state_id, expected_bypassed_edit_ids)?;
        let output_path = output_path.as_ref().to_path_buf();
        let uncertainty_path = uncertainty_sidecar_path(&output_path);
        self.ensure_new_external_export(&output_path, &[uncertainty_path.clone()])?;
        let temporary = tempfile::tempdir_in(output_path.parent().unwrap())?;
        let mut result = self.export_focus_fasta_for_track(
            &stored,
            context,
            temporary.path().join("region.fa"),
        )?;
        let mut files = vec![(result.fasta_path.clone(), output_path.clone())];
        if let Some(path) = &result.uncertainty_path {
            files.push((path.clone(), uncertainty_path.clone()));
        }
        publish_new_export_files(&files)?;
        result.fasta_path = output_path;
        result.uncertainty_path = result.uncertainty_path.map(|_| uncertainty_path);
        Ok(result)
    }

    fn export_focus_fasta_for_track(
        &self,
        stored: &StoredGenomeTrack,
        context: FocusContext,
        output_path: impl AsRef<Path>,
    ) -> Result<FocusFastaExport> {
        if context.start == 0
            || context.end < context.start
            || context.end.saturating_sub(context.start).saturating_add(1)
                > MAX_SEQUENCE_FOCUS_BASES
        {
            return Err(DgwError::Project(
                "FASTA export must be a valid reference interval no wider than 50 kb".into(),
            ));
        }
        let overlapping = self.effective_variants_in_context(
            &stored.track.head_state_id,
            &effective_bypassed_edit_ids(&stored),
            &context,
        )?;
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

    fn write_evidence_sidecar(
        &self,
        state_id: &str,
        output_path: &Path,
    ) -> Result<(PathBuf, FileFingerprint, usize)> {
        // Hold one read transaction across count and serialization so an
        // automatic evaluation completing concurrently cannot make coverage
        // disagree with the array written to this sidecar.
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let count: i64 =
            transaction.query_row("SELECT COUNT(*) FROM evaluations", [], |row| row.get(0))?;
        let entry_count = usize::try_from(count.max(0)).map_err(|_| {
            DgwError::Project("evaluation cache count exceeds this platform".into())
        })?;
        let sidecar_path = PathBuf::from(format!("{}.evidence.json.gz", output_path.display()));
        let file = File::create(&sidecar_path)?;
        let mut encoder = GzEncoder::new(file, Compression::default());
        let payload = EvidenceSidecar {
            schema_version: 1,
            project_id: &self.manifest.project_id,
            state_id,
            generated_at: Utc::now(),
            resource_bundle: EvidenceResourceIdentity {
                id: &self.manifest.resource_bundle.id,
                assembly: &self.manifest.assembly,
                fingerprint: &self.manifest.resource_bundle_fingerprint,
                consequence_engine: "bcftools csq",
                bcftools_version: &self.manifest.resource_bundle.bcftools_version,
                consequence_annotation_release: self
                    .manifest
                    .resource_bundle
                    .consequence_annotation
                    .as_ref()
                    .map(|resource| resource.release.as_str()),
                clinvar_release: &self.manifest.resource_bundle.clinvar.release,
                cosmic_release: &self.manifest.resource_bundle.cosmic.release,
            },
            coverage: EvidenceCoverage {
                cached_exact_allele_entries: entry_count,
                scope: "Only exact alleles evaluated in this project are included; absence from this file means not computed.",
            },
            evaluations: CachedEvaluationEntries {
                connection: &transaction,
                count: entry_count,
            },
            limitation: "Evidence applies independently to exact normalized alleles. Imported VCF annotations, compound effects, phase-dependent combined consequences, penetrance, and whole-genome effects are not included.",
        };
        serde_json::to_writer(&mut encoder, &payload)?;
        transaction.commit()?;
        encoder.finish()?;
        let fingerprint = fingerprint_file(&sidecar_path)?;
        Ok((sidecar_path, fingerprint, entry_count))
    }

    fn write_device_runs_sidecar(
        &self,
        output_path: &Path,
    ) -> Result<(PathBuf, FileFingerprint, usize)> {
        let connection = self.connection()?;
        let mut statement =
            connection.prepare("SELECT payload FROM device_runs ORDER BY completed_at, id")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut runs = Vec::new();
        for row in rows {
            runs.push(serde_json::from_str(&row?)?);
        }
        let run_count = runs.len();
        let sidecar_path = PathBuf::from(format!("{}.device-runs.json.gz", output_path.display()));
        let file = File::create(&sidecar_path)?;
        let mut encoder = GzEncoder::new(file, Compression::default());
        serde_json::to_writer(
            &mut encoder,
            &DeviceRunsSidecar {
                schema_version: 1,
                project_id: self.manifest.project_id.clone(),
                generated_at: Utc::now(),
                scope: "All immutable device runs recorded in this project, including failed and cancelled invocations.",
                run_count,
                runs,
                limitation: "A device run records its declared inputs, resources and terminal result. It does not by itself establish biological validity or clinical meaning.",
            },
        )?;
        encoder.finish()?;
        let fingerprint = fingerprint_file(&sidecar_path)?;
        Ok((sidecar_path, fingerprint, run_count))
    }

    pub fn render_state(
        &self,
        state_id: &str,
        bypassed_edit_ids: &[String],
        output_path: impl AsRef<Path>,
    ) -> Result<PathBuf> {
        self.render_state_for_destination(state_id, bypassed_edit_ids, output_path.as_ref(), None)
    }

    fn render_state_for_destination(
        &self,
        state_id: &str,
        bypassed_edit_ids: &[String],
        output_path: &Path,
        published: Option<&TrackVcfExport>,
    ) -> Result<PathBuf> {
        let mut output_path = output_path.to_path_buf();
        if !output_path.to_string_lossy().ends_with(".vcf.gz") {
            output_path.set_extension("vcf.gz");
        }
        let plain_path = output_path.with_extension("").with_extension("vcf");
        let operations = self.expanded_edits_to_state(state_id)?;
        let mut affected_keys: Vec<VariantKey> = operations
            .iter()
            .flat_map(|operation| edit_keys(&operation.edit))
            .cloned()
            .collect();
        affected_keys.sort();
        affected_keys.dedup();
        let affected_roots = self.root_variants_at_loci(&affected_keys)?;
        let affected_root_keys: BTreeSet<VariantKey> = affected_roots
            .iter()
            .map(|variant| variant.key.clone())
            .collect();
        let affected_metadata: BTreeMap<VariantKey, RootVariant> = affected_roots
            .iter()
            .cloned()
            .map(|variant| (variant.key.clone(), variant))
            .collect();
        let mut affected_variants =
            effective_variants(&affected_roots, &operations, bypassed_edit_ids)?;
        affected_variants.sort_by(|left, right| left.key.cmp(&right.key));
        let (evidence_path, evidence_fingerprint, evidence_entry_count) =
            self.write_evidence_sidecar(state_id, &output_path)?;
        let (device_runs_path, device_runs_fingerprint, device_run_count) =
            self.write_device_runs_sidecar(&output_path)?;
        let provenance_path = PathBuf::from(format!("{}.provenance.json", output_path.display()));
        let provenance = serde_json::json!({
            "schemaVersion": 1,
            "project": self.manifest,
            "stateId": state_id,
            "bypassedEditIds": bypassed_edit_ids,
            "edits": &operations,
            "renderedAt": Utc::now(),
            "evidenceSidecar": {
                "path": published.map(|paths| &paths.evidence_path).unwrap_or(&evidence_path),
                "sha256": evidence_fingerprint.sha256,
                "size": evidence_fingerprint.size,
                "cachedExactAlleleEntries": evidence_entry_count
            },
            "deviceRunsSidecar": {
                "path": published.map(|paths| &paths.device_runs_path).unwrap_or(&device_runs_path),
                "sha256": device_runs_fingerprint.sha256,
                "size": device_runs_fingerprint.size,
                "runCount": device_run_count
            },
            "inputAnnotationPolicy": "Imported VCF INFO annotations are preserved only in the frozen source artifact and are never copied into this rendered VCF or used as DGW evidence.",
            "limitation": "Evidence is evaluated independently per exact allele; compound haplotype consequences are not computed in DGW v1."
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
            "##DGWEvidenceSHA256={}",
            evidence_fingerprint.sha256
        )?;
        writeln!(
            output,
            "##DGWDeviceRunsSHA256={}",
            device_runs_fingerprint.sha256
        )?;
        writeln!(
            output,
            "##INFO=<ID=DGW_ORIGIN,Number=1,Type=String,Description=\"DGW allele origin\">"
        )?;
        writeln!(output, "##INFO=<ID=DGW_EDIT_IDS,Number=.,Type=String,Description=\"DGW edit operation identifiers\">")?;
        writeln!(output, "##INFO=<ID=DGW_SOURCE_KEY,Number=1,Type=String,Description=\"Original normalized allele key\">")?;
        writeln!(
            output,
            "##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">"
        )?;
        writeln!(
            output,
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t{}",
            self.manifest.selected_sample
        )?;
        // Only edit-touched loci are materialized above. Merge that bounded set
        // with the coordinate-ordered root stream so a million-variant export
        // never constructs a million-entry EffectiveVariant vector.
        let root_connection = self.connection()?;
        let mut root_statement = root_connection.prepare(
            "SELECT payload FROM root_variants
              ORDER BY assembly, contig, position, reference, alternate",
        )?;
        let root_rows = root_statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut affected = affected_variants.iter().peekable();
        for row in root_rows {
            let root: RootVariant = serde_json::from_str(&row?)?;
            while affected
                .peek()
                .is_some_and(|variant| variant.key < root.key)
            {
                let variant = affected.next().expect("peeked affected variant");
                let metadata = affected_metadata.get(&variant.key);
                write_rendered_variant(&mut output, variant, metadata)?;
            }

            if affected_root_keys.contains(&root.key) {
                if affected
                    .peek()
                    .is_some_and(|variant| variant.key == root.key)
                {
                    let variant = affected.next().expect("peeked affected variant");
                    let metadata = affected_metadata.get(&variant.key);
                    write_rendered_variant(&mut output, variant, metadata)?;
                }
                continue;
            }

            if affected
                .peek()
                .is_some_and(|variant| variant.key == root.key)
            {
                let variant = affected.next().expect("peeked affected variant");
                let metadata = affected_metadata.get(&variant.key);
                write_rendered_variant(&mut output, variant, metadata)?;
            } else {
                let variant = observed_effective_variant(&root);
                write_rendered_variant(&mut output, &variant, Some(&root))?;
            }
        }
        for variant in affected {
            let metadata = affected_metadata.get(&variant.key);
            write_rendered_variant(&mut output, variant, metadata)?;
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

    /// Render a complete track only if its explicit state and visible bypass
    /// choices still match the caller's view. Existing export artifacts are
    /// never overwritten, and destinations inside the project package are
    /// rejected.
    pub fn export_track_vcf_at_head(
        &self,
        track_id: &str,
        expected_head_state_id: &str,
        expected_bypassed_edit_ids: &[String],
        output_path: impl AsRef<Path>,
    ) -> Result<TrackVcfExport> {
        let stored = self.stored_track(track_id)?;
        ensure_track_export_state(&stored, expected_head_state_id, expected_bypassed_edit_ids)?;
        let artifacts = track_vcf_export_paths(output_path.as_ref());
        let plain_path = artifacts.vcf_path.with_extension("").with_extension("vcf");
        self.ensure_new_external_export(
            &artifacts.vcf_path,
            &[
                plain_path.clone(),
                artifacts.index_path.clone(),
                artifacts.evidence_path.clone(),
                artifacts.device_runs_path.clone(),
                artifacts.provenance_path.clone(),
            ],
        )?;
        let temporary = tempfile::tempdir_in(artifacts.vcf_path.parent().unwrap())?;
        let staged = track_vcf_export_paths(&temporary.path().join("track.vcf.gz"));
        self.render_state_for_destination(
            &stored.track.head_state_id,
            &effective_bypassed_edit_ids(&stored),
            &staged.vcf_path,
            Some(&artifacts),
        )?;
        publish_new_export_files(&[
            (staged.vcf_path, artifacts.vcf_path.clone()),
            (staged.index_path, artifacts.index_path.clone()),
            (staged.evidence_path, artifacts.evidence_path.clone()),
            (staged.device_runs_path, artifacts.device_runs_path.clone()),
            (staged.provenance_path, artifacts.provenance_path.clone()),
        ])?;
        Ok(artifacts)
    }

    fn ensure_new_external_export(&self, primary: &Path, related: &[PathBuf]) -> Result<()> {
        if !primary.is_absolute() {
            return Err(DgwError::Project(
                "export destination must be an absolute path".into(),
            ));
        }
        let parent = primary.parent().ok_or_else(|| {
            DgwError::Project("export destination has no parent directory".into())
        })?;
        if !parent.is_dir() {
            return Err(DgwError::Project(format!(
                "export directory does not exist: {}",
                parent.display()
            )));
        }
        let canonical_parent = parent.canonicalize()?;
        let canonical_project = self.root.canonicalize()?;
        if canonical_parent.starts_with(&canonical_project) {
            return Err(DgwError::Project(
                "exports must be written outside the .dgw project package".into(),
            ));
        }
        for path in std::iter::once(primary).chain(related.iter().map(PathBuf::as_path)) {
            if path.symlink_metadata().is_ok() {
                return Err(DgwError::Project(format!(
                    "export will not overwrite existing file: {}",
                    path.display()
                )));
            }
        }
        Ok(())
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
            // Rendered state VCFs carry only structure plus DGW provenance.
            // Imported INFO/annotation declarations remain in the frozen
            // selected-sample artifact and are intentionally not propagated.
            if line.starts_with("##contig=<") || line.starts_with("##FILTER=<") {
                headers.push(line);
            }
        }
        Ok(headers)
    }
}

fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)?;
        } else {
            return Err(DgwError::Project(format!(
                "project package contains an unsupported link or special file: {}",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

fn observed_effective_variant(root: &RootVariant) -> EffectiveVariant {
    EffectiveVariant {
        key: root.key.clone(),
        haplotype1_alt: root.haplotype1_alt,
        haplotype2_alt: root.haplotype2_alt,
        unphased_alt: root.unphased_alt,
        unphased_slot: root.unphased_slot,
        origin: VariantOrigin::Observed,
        edit_ids: Vec::new(),
        source_key: Some(root.key.clone()),
        source_info: BTreeMap::new(),
    }
}

fn write_rendered_variant<W: Write>(
    output: &mut W,
    variant: &EffectiveVariant,
    source_record: Option<&RootVariant>,
) -> Result<()> {
    let genotype = if variant.unphased_alt {
        match variant.unphased_slot {
            Some(1) => "1/0",
            _ => "0/1",
        }
    } else {
        match (variant.haplotype1_alt, variant.haplotype2_alt) {
            (true, true) => "1|1",
            (true, false) => "1|0",
            (false, true) => "0|1",
            (false, false) => return Ok(()),
        }
    };
    let origin = match variant.origin {
        VariantOrigin::Observed => "observed",
        VariantOrigin::Edited => "edited",
        VariantOrigin::Created => "created",
    };
    let mut info: BTreeMap<String, String> = BTreeMap::new();
    info.insert("DGW_ORIGIN".into(), origin.into());
    if !variant.edit_ids.is_empty() {
        info.insert("DGW_EDIT_IDS".into(), variant.edit_ids.join(","));
    }
    if let Some(source) = &variant.source_key {
        info.insert("DGW_SOURCE_KEY".into(), source.stable_key());
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
    let source_record = if variant.origin == VariantOrigin::Observed {
        source_record
    } else {
        None
    };
    let id = source_record
        .and_then(|record| record.id.as_deref())
        .unwrap_or(".");
    let quality = source_record
        .and_then(|record| record.quality.as_deref())
        .unwrap_or(".");
    let filter = source_record
        .map(|record| record.filter.as_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("PASS");
    writeln!(
        output,
        "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\tGT\t{}",
        variant.key.contig,
        variant.key.position,
        id,
        variant.key.reference,
        variant.key.alternate,
        quality,
        filter,
        info_text,
        genotype
    )?;
    Ok(())
}

fn variant_overlaps_context(key: &VariantKey, context: &FocusContext) -> bool {
    key.contig == context.contig && key.position <= context.end && key.end() >= context.start
}

type VcfKeyTuple = (String, String, String, String);

#[derive(Debug, Default, PartialEq, Eq)]
struct NormalizationSummary {
    changed_records: u64,
    input_records: u64,
    output_records: u64,
    first_change: Option<(Option<VcfKeyTuple>, Option<VcfKeyTuple>)>,
}

fn rewrite_vcf_contig_header(header: &str, reference_names: &BTreeSet<String>) -> Result<String> {
    const PREFIX: &str = "##contig=<ID=";
    let Some(rest) = header.strip_prefix(PREFIX) else {
        return Ok(header.into());
    };
    let end = rest
        .find([',', '>'])
        .ok_or_else(|| DgwError::InvalidVcf(format!("malformed contig header: {header}")))?;
    let source = &rest[..end];
    let Ok(target) = resolve_reference_contig(source, reference_names) else {
        // Headers commonly describe unused decoys. Retained records are
        // validated separately and are never allowed to remain unresolved.
        return Ok(header.into());
    };
    Ok(format!("{PREFIX}{target}{}", &rest[end..]))
}

impl NormalizationSummary {
    fn warning(&self) -> Option<String> {
        if self.changed_records == 0 && self.input_records == self.output_records {
            return None;
        }
        let record_word = if self.changed_records == 1 {
            "record"
        } else {
            "records"
        };
        let example = self
            .first_change
            .as_ref()
            .map(|(before, after)| {
                format!(
                    " Example: {} -> {}.",
                    display_vcf_key(before.as_ref()),
                    display_vcf_key(after.as_ref())
                )
            })
            .unwrap_or_default();
        let count_note = (self.input_records != self.output_records)
            .then(|| {
                format!(
                    " The selected projection changed from {} to {} records.",
                    self.input_records, self.output_records
                )
            })
            .unwrap_or_default();
        Some(format!(
            "DGW normalized {} selected allele {} against the configured reference while importing a project copy; the original source VCF was not changed.{}{}",
            self.changed_records, record_word, example, count_note
        ))
    }
}

fn display_vcf_key(key: Option<&VcfKeyTuple>) -> String {
    key.map(|(contig, position, reference, alternate)| {
        format!("{contig}:{position} {reference}>{alternate}")
    })
    .unwrap_or_else(|| "no record".into())
}

fn compare_vcf_normalization(
    projected_path: &Path,
    normalized_path: &Path,
) -> Result<NormalizationSummary> {
    let mut projected = BufReader::new(File::open(projected_path)?);
    let mut normalized = BufReader::new(File::open(normalized_path)?);
    let mut projected_line = String::new();
    let mut normalized_line = String::new();
    let mut summary = NormalizationSummary::default();
    loop {
        let before = next_vcf_key(&mut projected, &mut projected_line)?;
        let after = next_vcf_key(&mut normalized, &mut normalized_line)?;
        if before.is_some() {
            summary.input_records += 1;
        }
        if after.is_some() {
            summary.output_records += 1;
        }
        if before != after {
            summary.changed_records += 1;
            if summary.first_change.is_none() {
                summary.first_change = Some((before.clone(), after.clone()));
            }
        }
        if before.is_none() && after.is_none() {
            break;
        }
    }
    Ok(summary)
}

fn next_vcf_key<R: BufRead>(reader: &mut R, line: &mut String) -> Result<Option<VcfKeyTuple>> {
    loop {
        line.clear();
        if reader.read_line(line)? == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        let fields: Vec<&str> = trimmed.split('\t').collect();
        if fields.len() < 5 {
            return Err(DgwError::InvalidVcf(
                "VCF normalization output contains fewer than five columns".into(),
            ));
        }
        return Ok(Some((
            fields[0].into(),
            fields[1].into(),
            fields[3].into(),
            fields[4].into(),
        )));
    }
}

/// Interval lookup used by bulk selections. Stored ends are prefix maxima, so
/// overlap queries are logarithmic rather than scanning every selected locus.
struct VariantLocusIndex {
    intervals: BTreeMap<(String, String), Vec<(u64, u64)>>,
}

impl VariantLocusIndex {
    fn new(keys: &[VariantKey]) -> Self {
        let mut intervals: BTreeMap<(String, String), Vec<(u64, u64)>> = BTreeMap::new();
        for key in keys {
            intervals
                .entry((key.assembly.clone(), key.contig.clone()))
                .or_default()
                .push((key.position, key.end()));
        }
        for entries in intervals.values_mut() {
            entries.sort_unstable_by_key(|(start, end)| (*start, *end));
            let mut maximum_end = 0;
            for (_, end) in entries {
                maximum_end = maximum_end.max(*end);
                *end = maximum_end;
            }
        }
        Self { intervals }
    }

    fn overlaps(&self, key: &VariantKey) -> bool {
        let Some(entries) = self
            .intervals
            .get(&(key.assembly.clone(), key.contig.clone()))
        else {
            return false;
        };
        let upper = entries.partition_point(|(start, _)| *start <= key.end());
        upper > 0 && entries[upper - 1].1 >= key.position
    }
}

fn edit_keys(edit: &EditKind) -> Vec<&VariantKey> {
    match edit {
        EditKind::SetAllele {
            key, source_key, ..
        } => {
            let mut keys = vec![key];
            if let Some(source_key) = source_key {
                keys.push(source_key);
            }
            keys
        }
        EditKind::RestoreReference { source_key } => vec![source_key],
        EditKind::CompoundMutationLayer { .. } => Vec::new(),
    }
}

fn primary_edit_key(edit: &EditKind) -> Result<&VariantKey> {
    match edit {
        EditKind::SetAllele { key, .. } => Ok(key),
        EditKind::RestoreReference { source_key } => Ok(source_key),
        EditKind::CompoundMutationLayer { .. } => Err(DgwError::InvalidEdit(
            "a compound mutation layer cannot be nested".into(),
        )),
    }
}

fn append_compound_operations(
    target: &mut Vec<EditOperation>,
    marker: &EditOperation,
    changes: Vec<CompoundMutationChange>,
) {
    target.extend(changes.into_iter().map(|change| EditOperation {
        // Every child shares the marker id. Bypassing or undoing the one
        // visible block therefore excludes the complete layer atomically.
        id: marker.id.clone(),
        parent_state_id: marker.parent_state_id.clone(),
        haplotype: change.haplotype,
        edit: change.edit,
        note: marker.note.clone(),
        created_at: marker.created_at,
    }));
}

fn track_mutation_from_edit(
    edit_id: &str,
    haplotype: Haplotype,
    edit: &EditKind,
) -> Option<TrackMutation> {
    match edit {
        EditKind::SetAllele {
            key, source_key, ..
        } => Some(TrackMutation {
            edit_id: edit_id.into(),
            haplotype,
            source_variant: source_key.clone().unwrap_or_else(|| key.clone()),
            current_variant: Some(key.clone()),
        }),
        EditKind::RestoreReference { source_key } => Some(TrackMutation {
            edit_id: edit_id.into(),
            haplotype,
            source_variant: source_key.clone(),
            current_variant: None,
        }),
        EditKind::CompoundMutationLayer { .. } => None,
    }
}

fn edit_overlaps_context(edit: &EditKind, context: &FocusContext) -> bool {
    edit_keys(edit)
        .into_iter()
        .any(|key| variant_overlaps_context(key, context))
}

fn context_for_edit(edit: &EditKind) -> Result<FocusContext> {
    let keys = edit_keys(edit);
    let first = keys
        .first()
        .ok_or_else(|| DgwError::InvalidEdit("edit has no allele key".into()))?;
    if keys
        .iter()
        .any(|key| key.assembly != first.assembly || key.contig != first.contig)
    {
        return Err(DgwError::InvalidEdit(
            "one edit cannot move an allele between assemblies or contigs".into(),
        ));
    }
    Ok(FocusContext {
        contig: first.contig.clone(),
        start: keys
            .iter()
            .map(|key| key.position)
            .min()
            .unwrap_or(first.position),
        end: keys
            .iter()
            .map(|key| key.end())
            .max()
            .unwrap_or_else(|| first.end()),
    })
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

fn update_stored_track_if_unchanged(
    connection: &Connection,
    stored: &StoredGenomeTrack,
    original_payload: &str,
    recovery: &str,
) -> Result<()> {
    let updated = connection.execute(
        "UPDATE tracks SET payload = ?2 WHERE id = ?1 AND payload = ?3",
        params![
            stored.track.id,
            serde_json::to_string(stored)?,
            original_payload
        ],
    )?;
    if updated == 0 {
        return Err(DgwError::Project(format!(
            "genome track {} changed during the operation; {recovery}",
            stored.track.id,
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

fn ensure_track_export_state(
    stored: &StoredGenomeTrack,
    expected_head_state_id: &str,
    expected_bypassed_edit_ids: &[String],
) -> Result<()> {
    if stored.track.head_state_id != expected_head_state_id
        || stored.track.bypassed_edit_ids != expected_bypassed_edit_ids
    {
        return Err(DgwError::Project(
            "the track changed after it was inspected; refresh it before exporting".into(),
        ));
    }
    Ok(())
}

fn track_vcf_export_paths(output_path: &Path) -> TrackVcfExport {
    let mut vcf_path = output_path.to_path_buf();
    if !vcf_path.to_string_lossy().ends_with(".vcf.gz") {
        vcf_path.set_extension("vcf.gz");
    }
    TrackVcfExport {
        index_path: PathBuf::from(format!("{}.csi", vcf_path.display())),
        evidence_path: PathBuf::from(format!("{}.evidence.json.gz", vcf_path.display())),
        device_runs_path: PathBuf::from(format!("{}.device-runs.json.gz", vcf_path.display())),
        provenance_path: PathBuf::from(format!("{}.provenance.json", vcf_path.display())),
        vcf_path,
    }
}

fn publish_new_export_files(files: &[(PathBuf, PathBuf)]) -> Result<()> {
    // Reserve every destination atomically before writing through the owned
    // handles. A collision never truncates another export or follows a symlink.
    let mut reserved = Vec::new();
    let result = (|| -> Result<()> {
        for (_, destination) in files {
            let file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)?;
            reserved.push((destination.clone(), file));
        }
        for ((source, _), (_, destination)) in files.iter().zip(reserved.iter_mut()) {
            std::io::copy(&mut File::open(source)?, destination)?;
            destination.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        for (path, file) in reserved {
            drop(file);
            let _ = fs::remove_file(path);
        }
    }
    result
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

    #[test]
    fn bulk_locus_index_handles_overlaps_without_pairwise_scanning() {
        let keys: Vec<VariantKey> = (1..=50_000)
            .map(|position| VariantKey {
                assembly: "b37".into(),
                contig: "1".into(),
                position,
                reference: "A".into(),
                alternate: "C".into(),
            })
            .collect();
        let index = VariantLocusIndex::new(&keys);
        assert!(index.overlaps(&keys[24_999]));
        assert!(!index.overlaps(&VariantKey {
            assembly: "b37".into(),
            contig: "2".into(),
            position: 25_000,
            reference: "A".into(),
            alternate: "G".into(),
        }));
    }

    #[test]
    fn background_jobs_are_persistent_project_records() {
        let (_temporary, project) = test_project();
        let now = Utc::now();
        let job = BackgroundJob {
            id: "job-fixture".into(),
            operation: "mutationGeneratorPreview".into(),
            device_id: "org.dgw.builtin.mutation-generator".into(),
            track_id: project.workspace().unwrap().active_track_id,
            status: BackgroundJobStatus::Completed,
            progress: 100,
            stage: "completed".into(),
            message: "Complete".into(),
            worker_threads: 4,
            request: serde_json::json!({"selection": "allTrack"}),
            result: Some(serde_json::json!({"randomizedPositions": 42})),
            error: None,
            created_at: now,
            updated_at: now,
        };
        project.save_background_job(&job).unwrap();
        assert_eq!(project.background_job(&job.id).unwrap(), job);
        assert_eq!(project.list_background_jobs(10).unwrap(), vec![job]);
    }

    #[test]
    fn agent_exports_require_current_state_and_new_external_paths() {
        let (temporary, project) = test_project();
        let track = project.active_track().unwrap();

        let stale = project
            .export_focus_fasta_at_head(
                &track.id,
                "stale-state",
                &track.bypassed_edit_ids,
                FocusContext {
                    contig: "1".into(),
                    start: 1,
                    end: 10,
                },
                temporary.path().join("stale.fa"),
            )
            .unwrap_err();
        assert!(stale.to_string().contains("track changed"));

        fs::create_dir_all(project.root().join("exports")).unwrap();
        let inside = project
            .export_track_vcf_at_head(
                &track.id,
                &track.head_state_id,
                &track.bypassed_edit_ids,
                project.root().join("exports/agent.vcf.gz"),
            )
            .unwrap_err();
        assert!(inside.to_string().contains("outside the .dgw"));

        let existing = temporary.path().join("existing.vcf.gz");
        File::create(&existing).unwrap();
        let collision = project
            .export_track_vcf_at_head(
                &track.id,
                &track.head_state_id,
                &track.bypassed_edit_ids,
                existing,
            )
            .unwrap_err();
        assert!(collision.to_string().contains("will not overwrite"));

        let too_wide = project
            .export_focus_fasta_at_head(
                &track.id,
                &track.head_state_id,
                &track.bypassed_edit_ids,
                FocusContext {
                    contig: "1".into(),
                    start: 1,
                    end: MAX_SEQUENCE_FOCUS_BASES + 1,
                },
                temporary.path().join("too-wide.fa"),
            )
            .unwrap_err();
        assert!(too_wide.to_string().contains("no wider than 50 kb"));
    }

    #[test]
    fn track_vcf_export_paths_report_the_complete_artifact_set() {
        let paths = track_vcf_export_paths(Path::new("/tmp/example"));
        assert_eq!(paths.vcf_path, PathBuf::from("/tmp/example.vcf.gz"));
        assert_eq!(paths.index_path, PathBuf::from("/tmp/example.vcf.gz.csi"));
        assert_eq!(
            paths.evidence_path,
            PathBuf::from("/tmp/example.vcf.gz.evidence.json.gz")
        );
        assert_eq!(
            paths.device_runs_path,
            PathBuf::from("/tmp/example.vcf.gz.device-runs.json.gz")
        );
        assert_eq!(
            paths.provenance_path,
            PathBuf::from("/tmp/example.vcf.gz.provenance.json")
        );
    }

    #[test]
    fn device_runs_are_immutable_and_survive_reopen() {
        let (_temporary, project) = test_project();
        let track = project.active_track().unwrap();
        let selection = serde_json::json!({"kind": "allTrack", "selectedPositions": 42});
        let parameters = serde_json::json!({"mode": "randomizer", "seed": 7});
        let input_fingerprint = project
            .device_run_input_fingerprint(
                "org.dgw.builtin.mutation-generator",
                "0.1.0",
                &track.id,
                &track.head_state_id,
                &selection,
                &parameters,
            )
            .unwrap();
        let now = Utc::now();
        let run = DeviceRunRecord {
            id: "device-run-fixture".into(),
            device_id: "org.dgw.builtin.mutation-generator".into(),
            device_version: "0.1.0".into(),
            operation: "mutationGeneratorPreview".into(),
            track_id: track.id,
            input_state_id: track.head_state_id,
            input_fingerprint,
            selection,
            parameters,
            resource_bundle_fingerprint: project.manifest().resource_bundle_fingerprint.clone(),
            resource_context: project.device_run_resource_context(),
            result_summary: serde_json::json!({"randomizedPositions": 42}),
            output_edit_ids: Vec::new(),
            compound_layer_id: Some("layer-fixture".into()),
            status: DeviceRunStatus::Completed,
            error: None,
            limitation: "Randomized alleles are synthetic edits, not predictions.".into(),
            started_at: now,
            completed_at: now,
        };

        project.save_device_run(&run).unwrap();
        let duplicate_error = project.save_device_run(&run).unwrap_err();
        assert!(duplicate_error.to_string().contains("immutable"));

        let reopened = Project::open(project.root()).unwrap();
        assert_eq!(reopened.device_run(&run.id).unwrap(), run);
        assert_eq!(reopened.list_device_runs(10).unwrap(), vec![run]);
        assert_eq!(reopened.delete_finished_background_jobs().unwrap(), 0);
        assert_eq!(reopened.list_device_runs(10).unwrap().len(), 1);

        let rendered = reopened
            .render_track(
                &reopened.active_track().unwrap().id,
                reopened.root().join("device-run-export.vcf.gz"),
            )
            .unwrap();
        let sidecar = PathBuf::from(format!("{}.device-runs.json.gz", rendered.display()));
        let exported: serde_json::Value =
            serde_json::from_reader(MultiGzDecoder::new(File::open(sidecar).unwrap())).unwrap();
        assert_eq!(exported["schemaVersion"], 1);
        assert_eq!(exported["runCount"], 1);
        assert_eq!(exported["runs"][0]["id"], "device-run-fixture");
    }

    #[test]
    fn deletes_only_finished_background_job_records() {
        let (_temporary, project) = test_project();
        let now = Utc::now();
        let base = BackgroundJob {
            id: "completed-job".into(),
            operation: "test".into(),
            device_id: "test-device".into(),
            track_id: project.workspace().unwrap().active_track_id,
            status: BackgroundJobStatus::Completed,
            progress: 100,
            stage: "completed".into(),
            message: "Complete".into(),
            worker_threads: 1,
            request: serde_json::json!({}),
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
        };
        let mut failed = base.clone();
        failed.id = "failed-job".into();
        failed.status = BackgroundJobStatus::Failed;
        let mut cancelled = base.clone();
        cancelled.id = "cancelled-job".into();
        cancelled.status = BackgroundJobStatus::Cancelled;
        let mut running = base.clone();
        running.id = "running-job".into();
        running.status = BackgroundJobStatus::Running;
        running.progress = 30;
        for job in [&base, &failed, &cancelled, &running] {
            project.save_background_job(job).unwrap();
        }

        assert_eq!(project.delete_finished_background_jobs().unwrap(), 3);
        assert_eq!(project.list_background_jobs(10).unwrap(), vec![running]);
    }

    #[test]
    fn compound_mutation_layer_is_one_reversible_block_with_exact_projection() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let roots = vec![observed_variant("1", 100), observed_variant("2", 200)];
        insert_root_variants(&project, &roots);
        let changes: Vec<_> = roots
            .iter()
            .enumerate()
            .map(|(index, root)| CompoundMutationChange {
                haplotype: Haplotype::One,
                edit: EditKind::SetAllele {
                    key: VariantKey {
                        alternate: if index == 0 { "G" } else { "T" }.into(),
                        ..root.key.clone()
                    },
                    source_key: Some(root.key.clone()),
                    unphased_slot: None,
                },
            })
            .collect();
        let layer = project
            .stage_compound_mutation_layer(
                &working.id,
                &working.head_state_id,
                "org.dgw.builtin.mutation-generator",
                2,
                &changes,
                Some("Bulk randomization".into()),
            )
            .unwrap();
        let state = project
            .apply_compound_mutation_layer(&working.id, &layer.id)
            .unwrap();
        let edit_id = state.edit_id.unwrap();

        let visible = project.edits_for_track(&working.id).unwrap();
        assert_eq!(visible.len(), 1);
        assert!(matches!(
            visible[0].edit,
            EditKind::CompoundMutationLayer {
                position_count: 2,
                change_count: 2,
                ..
            }
        ));
        let effective = project.effective_variants_for_track(&working.id).unwrap();
        assert_eq!(effective.len(), 2);
        assert!(effective.iter().any(|variant| {
            variant.key.contig == "1"
                && variant.key.alternate == "G"
                && variant.edit_ids == vec![edit_id.clone()]
        }));
        assert!(effective.iter().any(|variant| {
            variant.key.contig == "2"
                && variant.key.alternate == "T"
                && variant.edit_ids == vec![edit_id.clone()]
        }));
        let mutations = project.active_track_mutations(&working.id).unwrap();
        assert_eq!(mutations.len(), 2);
        assert!(mutations.iter().all(|mutation| mutation.edit_id == edit_id));
        assert!(mutations.iter().all(|mutation| mutation
            .current_variant
            .as_ref()
            .is_some_and(|key| key.alternate != "C")));

        let focused = project
            .effective_variants_for_track_in_context(
                &working.id,
                &FocusContext {
                    contig: "2".into(),
                    start: 190,
                    end: 210,
                },
            )
            .unwrap();
        assert_eq!(focused.len(), 1);
        assert_eq!(focused[0].key.alternate, "T");

        let pending = project
            .stage_compound_mutation_layer(
                &working.id,
                &state.id,
                "org.dgw.builtin.mutation-generator",
                1,
                &[CompoundMutationChange {
                    haplotype: Haplotype::One,
                    edit: EditKind::RestoreReference {
                        source_key: effective[0].key.clone(),
                    },
                }],
                None,
            )
            .unwrap();

        project
            .toggle_track_edit_bypass(&working.id, &edit_id, true)
            .unwrap();
        let bypassed = project.effective_variants_for_track(&working.id).unwrap();
        assert!(bypassed.iter().all(|variant| variant.key.alternate == "C"));
        let reopened = Project::open(project.root()).unwrap();
        assert_eq!(reopened.track(&working.id).unwrap().head_state_id, state.id);
        let error = reopened
            .apply_compound_mutation_layer(&working.id, &pending.id)
            .unwrap_err();
        assert!(error.to_string().contains("bypass state"));
        assert_eq!(
            reopened.effective_variants_for_track(&working.id).unwrap(),
            bypassed
        );
        assert!(reopened
            .compound_mutation_layer(&pending.id)
            .unwrap()
            .applied_edit_id
            .is_none());
        reopened
            .toggle_track_edit_bypass(&working.id, &edit_id, false)
            .unwrap();
        reopened
            .apply_compound_mutation_layer(&working.id, &pending.id)
            .unwrap();
    }

    #[test]
    fn large_compound_layer_keeps_history_and_variant_pages_bounded() {
        const POSITION_COUNT: u64 = 10_000;
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let roots: Vec<_> = (1..=POSITION_COUNT)
            .map(|position| observed_variant("1", position))
            .collect();
        insert_root_variants(&project, &roots);
        let changes: Vec<_> = roots
            .iter()
            .map(|root| CompoundMutationChange {
                haplotype: Haplotype::One,
                edit: EditKind::SetAllele {
                    key: VariantKey {
                        alternate: "G".into(),
                        ..root.key.clone()
                    },
                    source_key: Some(root.key.clone()),
                    unphased_slot: None,
                },
            })
            .collect();

        let layer = project
            .stage_compound_mutation_layer(
                &working.id,
                &working.head_state_id,
                "org.dgw.builtin.mutation-generator",
                POSITION_COUNT as u32,
                &changes,
                Some("10k acceptance layer".into()),
            )
            .unwrap();
        project
            .apply_compound_mutation_layer(&working.id, &layer.id)
            .unwrap();

        assert_eq!(project.edits_for_track(&working.id).unwrap().len(), 1);
        assert_eq!(
            project
                .compound_mutation_layer(&layer.id)
                .unwrap()
                .change_count,
            POSITION_COUNT as u32
        );
        let page = project.variant_page(&working.id, 0, 10_000).unwrap();
        assert_eq!(page.total, POSITION_COUNT);
        assert_eq!(page.variants.len(), VARIANT_PAGE_SIZE as usize);
        assert!(page.has_more);
        assert!(page
            .variants
            .iter()
            .all(|variant| variant.key.alternate == "G"));

        let reopened = Project::open(&project.root).unwrap();
        assert_eq!(reopened.edits_for_track(&working.id).unwrap().len(), 1);
        assert_eq!(
            reopened
                .compound_mutation_layer(&layer.id)
                .unwrap()
                .change_count,
            POSITION_COUNT as u32
        );
    }

    #[test]
    fn morph_layer_rejects_target_bypass_after_reopen() {
        let (_temporary, project) = test_project();
        let source = project.active_track().unwrap();
        let root = observed_variant("1", 100);
        insert_root_variants(&project, &[root.clone()]);
        let target = project.duplicate_track(&source.id, "Morph target").unwrap();
        let state = project
            .apply_edit_to_track(
                &target.id,
                Haplotype::One,
                EditKind::RestoreReference {
                    source_key: root.key.clone(),
                },
                None,
            )
            .unwrap();
        let target = project.track(&target.id).unwrap();
        let layer = project
            .stage_morph_layer(
                &source,
                &target,
                1,
                &[CompoundMutationChange {
                    haplotype: Haplotype::One,
                    edit: EditKind::RestoreReference {
                        source_key: root.key,
                    },
                }],
                None,
            )
            .unwrap();
        project
            .toggle_track_edit_bypass(&target.id, state.edit_id.as_ref().unwrap(), true)
            .unwrap();
        let reopened = Project::open(project.root()).unwrap();
        assert!(reopened
            .apply_compound_mutation_layer(&source.id, &layer.id)
            .unwrap_err()
            .to_string()
            .contains("target changed"));
        assert_eq!(
            reopened.track(&source.id).unwrap().head_state_id,
            source.head_state_id
        );
        reopened
            .toggle_track_edit_bypass(&target.id, state.edit_id.as_ref().unwrap(), false)
            .unwrap();
        reopened
            .apply_compound_mutation_layer(&source.id, &layer.id)
            .unwrap();
    }

    #[test]
    fn export_publication_rolls_back_only_owned_files_and_has_one_winner() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("input");
        fs::write(&input, b"complete export").unwrap();
        let first = directory.path().join("first");
        let collision = directory.path().join("collision");
        fs::write(&collision, b"keep this").unwrap();
        assert!(publish_new_export_files(&[
            (input.clone(), first.clone()),
            (input.clone(), collision.clone())
        ])
        .is_err());
        assert!(!first.exists());
        assert_eq!(fs::read(&collision).unwrap(), b"keep this");
        let barrier = std::sync::Barrier::new(2);
        let wins = std::thread::scope(|scope| {
            let run = || {
                barrier.wait();
                publish_new_export_files(&[(input.clone(), first.clone())]).is_ok()
            };
            let a = scope.spawn(run);
            let b = scope.spawn(run);
            usize::from(a.join().unwrap()) + usize::from(b.join().unwrap())
        });
        assert_eq!(wins, 1);
        assert_eq!(fs::read(&first).unwrap(), b"complete export");
    }

    #[test]
    fn compound_mutation_layer_rejects_a_changed_track_head() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let layer = project
            .stage_compound_mutation_layer(
                &working.id,
                &working.head_state_id,
                "org.dgw.builtin.mutation-generator",
                1,
                &[CompoundMutationChange {
                    haplotype: Haplotype::One,
                    edit: create_allele(100, "G"),
                }],
                None,
            )
            .unwrap();
        project
            .apply_edit_to_track(&working.id, Haplotype::One, create_allele(200, "T"), None)
            .unwrap();
        let error = project
            .apply_compound_mutation_layer(&working.id, &layer.id)
            .unwrap_err();
        assert!(error.to_string().contains("changed after preview"));
    }

    fn test_resource(path: &Path) -> IndexedResource {
        IndexedResource {
            path: path.join("resource.vcf.gz"),
            index_path: path.join("resource.vcf.gz.tbi"),
            release: "test".into(),
            license_label: "test".into(),
            contig_style: None,
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
            bcftools_path: temporary.path().join("bcftools"),
            bcftools_version: "test".into(),
            bgzip_path: "gzip".into(),
            tabix_path: "true".into(),
            clinvar: test_resource(temporary.path()),
            cosmic: test_resource(temporary.path()),
            gene_annotation: None,
            consequence_annotation: None,
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
            copied_from_project_id: None,
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

    #[test]
    fn runtime_database_connections_do_not_repeat_schema_writes() {
        let (_temporary, project) = test_project();

        let connection = project.connection().unwrap();

        assert_eq!(connection.total_changes(), 0);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM tracks", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn previewed_allele_edits_are_non_destructive_and_reject_stale_heads() {
        let (_temporary, project) = test_project();
        let tracks = project.list_tracks().unwrap();
        let source = tracks.iter().find(|track| track.read_only).unwrap();
        let working = tracks.iter().find(|track| !track.read_only).unwrap();
        let roots = [observed_variant("1", 100), observed_variant("1", 200)];
        insert_root_variants(&project, &roots);
        let restore_first = EditKind::RestoreReference {
            source_key: roots[0].key.clone(),
        };

        let source_error = project
            .preview_allele_edit(
                &source.id,
                &source.head_state_id,
                Haplotype::One,
                restore_first.clone(),
            )
            .unwrap_err();
        assert!(source_error.to_string().contains("read-only"));

        let preview = project
            .preview_allele_edit(
                &working.id,
                &working.head_state_id,
                Haplotype::One,
                restore_first.clone(),
            )
            .unwrap();
        assert_eq!(preview.effective_before.len(), 1);
        assert!(preview.effective_after.is_empty());
        assert_eq!(project.edits_for_track(&working.id).unwrap().len(), 0);
        assert_eq!(
            project.track(&working.id).unwrap().head_state_id,
            working.head_state_id
        );

        project
            .apply_edit_to_track(
                &working.id,
                Haplotype::One,
                EditKind::RestoreReference {
                    source_key: roots[1].key.clone(),
                },
                None,
            )
            .unwrap();
        let stale_error = project
            .apply_previewed_allele_edit(
                &working.id,
                &working.head_state_id,
                &preview.id,
                Haplotype::One,
                restore_first.clone(),
                None,
            )
            .unwrap_err();
        assert!(stale_error.to_string().contains("preview it again"));
        assert_eq!(project.edits_for_track(&working.id).unwrap().len(), 1);

        let current = project.track(&working.id).unwrap();
        let fresh = project
            .preview_allele_edit(
                &working.id,
                &current.head_state_id,
                Haplotype::One,
                restore_first.clone(),
            )
            .unwrap();
        let (_, state) = project
            .apply_previewed_allele_edit(
                &working.id,
                &current.head_state_id,
                &fresh.id,
                Haplotype::One,
                restore_first,
                Some("Restore selected allele".into()),
            )
            .unwrap();
        assert_eq!(
            state.parent_id.as_deref(),
            Some(current.head_state_id.as_str())
        );
        assert_eq!(project.edits_for_track(&working.id).unwrap().len(), 2);
        assert!(project
            .effective_variants_for_track_at_loci(&working.id, &[roots[0].key.clone()])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn shared_randomizer_preview_stages_without_moving_the_track_head() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        insert_root_variants(
            &project,
            &[observed_variant("1", 100), observed_variant("2", 200)],
        );
        let preview = project
            .prepare_randomizer_preview(
                &working.id,
                &working.head_state_id,
                RandomizerRequest {
                    selected_variants: Vec::new(),
                    amount: 100,
                    seed: 42,
                    substitution_pattern: crate::randomizer::SubstitutionPattern::Uniform,
                    transition_probability: 67,
                },
                Some(&VariantSelection::AllTrack {
                    track_id: working.id.clone(),
                    exclusions: Vec::new(),
                }),
                Some(10),
                true,
            )
            .unwrap();

        assert_eq!(preview.selected_positions, 2);
        assert_eq!(preview.randomized_positions, 2);
        assert!(preview.compound_layer_id.is_some());
        assert_eq!(
            project.track(&working.id).unwrap().head_state_id,
            working.head_state_id
        );
        assert!(project.edits_for_track(&working.id).unwrap().is_empty());

        let state = project
            .apply_compound_mutation_layer(
                &working.id,
                preview.compound_layer_id.as_deref().unwrap(),
            )
            .unwrap();
        assert_eq!(
            state.parent_id.as_deref(),
            Some(working.head_state_id.as_str())
        );
        assert_eq!(
            project.active_track_mutations(&working.id).unwrap().len(),
            2
        );
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
            unphased_slot: None,
        }
    }

    fn observed_variant(contig: &str, position: u64) -> RootVariant {
        RootVariant {
            key: VariantKey {
                assembly: "b37".into(),
                contig: contig.into(),
                position,
                reference: "A".into(),
                alternate: "C".into(),
            },
            id: None,
            quality: None,
            filter: "PASS".into(),
            info: BTreeMap::new(),
            format_keys: Vec::new(),
            sample_values: Vec::new(),
            haplotype1_alt: true,
            haplotype2_alt: false,
            unphased_alt: false,
            unphased_slot: None,
            source_line: String::new(),
        }
    }

    fn insert_root_variants(project: &Project, variants: &[RootVariant]) {
        let mut connection = project.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        for variant in variants {
            transaction
                .execute(
                    "INSERT INTO root_variants(
                        stable_key, payload, assembly, contig, position, end_position, reference, alternate
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![
                        variant.key.stable_key(),
                        serde_json::to_string(variant).unwrap(),
                        &variant.key.assembly,
                        &variant.key.contig,
                        variant.key.position,
                        variant.key.end(),
                        &variant.key.reference,
                        &variant.key.alternate,
                    ],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
    }

    #[test]
    fn deterministic_hashes_are_stable() {
        assert_eq!(hash_text("DGW"), hash_text("DGW"));
        assert_ne!(hash_text("DGW"), hash_text("dgw"));
    }

    #[test]
    fn reports_alleles_changed_by_import_normalization() {
        let mut projected = tempfile::NamedTempFile::new().unwrap();
        let mut normalized = tempfile::NamedTempFile::new().unwrap();
        for file in [&mut projected, &mut normalized] {
            writeln!(file, "##fileformat=VCFv4.2").unwrap();
            writeln!(
                file,
                "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tTEST"
            )
            .unwrap();
        }
        writeln!(projected, "1\t970549\t.\tTGG\tTG\t.\tPASS\t.\tGT\t0/1").unwrap();
        writeln!(normalized, "1\t970549\t.\tTG\tT\t.\tPASS\t.\tGT\t0/1").unwrap();

        let summary = compare_vcf_normalization(projected.path(), normalized.path()).unwrap();
        assert_eq!(summary.changed_records, 1);
        assert_eq!(summary.input_records, 1);
        assert_eq!(summary.output_records, 1);
        let warning = summary.warning().unwrap();
        assert!(warning.contains("normalized 1 selected allele record"));
        assert!(warning.contains("1:970549 TGG>TG -> 1:970549 TG>T"));
        assert!(warning.contains("original source VCF was not changed"));
    }

    #[test]
    fn does_not_warn_when_import_projection_is_already_normalized() {
        let mut projected = tempfile::NamedTempFile::new().unwrap();
        let mut normalized = tempfile::NamedTempFile::new().unwrap();
        for file in [&mut projected, &mut normalized] {
            writeln!(file, "##fileformat=VCFv4.2").unwrap();
            writeln!(file, "1\t100\t.\tA\tT\t.\tPASS\t.\tGT\t0/1").unwrap();
        }

        let summary = compare_vcf_normalization(projected.path(), normalized.path()).unwrap();
        assert_eq!(summary.changed_records, 0);
        assert!(summary.warning().is_none());
    }

    #[test]
    fn comparison_pages_group_multiallelic_loci_and_bound_payloads() {
        let (_temporary, project) = test_project();
        let track = project.active_track().unwrap();
        let mut roots: Vec<_> = (1..=205)
            .map(|position| observed_variant("1", position))
            .collect();
        let mut second = roots[199].clone();
        second.key.alternate = "T".into();
        second.haplotype1_alt = false;
        second.haplotype2_alt = true;
        roots.push(second);
        insert_root_variants(&project, &roots);
        let first = project
            .track_comparison_page(&track.id, 0, u32::MAX)
            .unwrap();
        assert_eq!(first.total_loci, 205);
        assert_eq!(first.rows.len(), 200);
        assert_eq!(first.rows[199].source.len(), 2);
        assert!(first.rows.iter().all(|row| !row.changed));
        let next = project.track_comparison_page(&track.id, 200, 200).unwrap();
        assert_eq!(next.rows.len(), 5);
        assert_eq!(next.rows[0].position, 201);
        assert!(!next.has_more);
        assert_eq!(first.revision, next.revision);
    }

    #[test]
    fn comparison_uses_final_copy_state_after_restore_bypass_and_consolidation() {
        let (_temporary, project) = test_project();
        let track = project.active_track().unwrap();
        let mut root = observed_variant("1", 100);
        root.haplotype2_alt = true;
        insert_root_variants(&project, &[root.clone()]);
        let baseline = project.track_comparison_page(&track.id, 0, 200).unwrap();
        let state = project
            .apply_edit_to_track(
                &track.id,
                Haplotype::One,
                EditKind::RestoreReference {
                    source_key: root.key,
                },
                None,
            )
            .unwrap();
        let changed = project.track_comparison_page(&track.id, 0, 200).unwrap();
        assert!(changed.rows[0].changed);
        assert_eq!(changed.rows[0].current.len(), 1);
        assert!(!changed.rows[0].current[0].haplotype1_alt);
        assert!(changed.rows[0].current[0].haplotype2_alt);
        let edit = state.edit_id.unwrap();
        project
            .toggle_track_edit_bypass(&track.id, &edit, true)
            .unwrap();
        let bypassed = project.track_comparison_page(&track.id, 0, 200).unwrap();
        assert!(!bypassed.rows[0].changed);
        assert_ne!(changed.revision, bypassed.revision);
        project
            .toggle_track_edit_bypass(&track.id, &edit, false)
            .unwrap();
        project.consolidate_track(&track.id).unwrap();
        let consolidated = project.track_comparison_page(&track.id, 0, 200).unwrap();
        assert_eq!(changed.rows, consolidated.rows);
        assert!(!baseline.rows[0].changed);
    }

    #[test]
    fn comparison_ignores_edit_history_when_the_original_allele_is_recreated() {
        let (_temporary, project) = test_project();
        let track = project.active_track().unwrap();
        let root = observed_variant("1", 100);
        insert_root_variants(&project, &[root.clone()]);
        let mut alternative = root.key.clone();
        alternative.alternate = "T".into();
        project
            .apply_edit_to_track(
                &track.id,
                Haplotype::One,
                EditKind::SetAllele {
                    key: alternative.clone(),
                    source_key: Some(root.key.clone()),
                    unphased_slot: None,
                },
                None,
            )
            .unwrap();
        project
            .apply_edit_to_track(
                &track.id,
                Haplotype::One,
                EditKind::SetAllele {
                    key: root.key,
                    source_key: Some(alternative),
                    unphased_slot: None,
                },
                None,
            )
            .unwrap();
        let page = project.track_comparison_page(&track.id, 0, 200).unwrap();
        assert!(!page.rows[0].changed);
        assert_eq!(project.edits_for_track(&track.id).unwrap().len(), 2);
    }

    #[test]
    fn comparison_preserves_unphased_multiallelic_genotype_slots() {
        let (_temporary, project) = test_project();
        let track = project.active_track().unwrap();
        let mut first = observed_variant("1", 100);
        first.haplotype1_alt = false;
        first.unphased_alt = true;
        first.unphased_slot = Some(1);
        let mut second = first.clone();
        second.key.alternate = "T".into();
        second.unphased_slot = Some(2);
        insert_root_variants(&project, &[first, second]);
        let page = project.track_comparison_page(&track.id, 0, 1).unwrap();
        assert_eq!(page.total_loci, 1);
        assert_eq!(page.rows[0].source.len(), 2);
        assert!(!page.rows[0].changed);
        assert_eq!(
            page.rows[0]
                .current
                .iter()
                .filter_map(|v| v.unphased_slot)
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([1, 2])
        );
    }

    #[test]
    fn variant_pages_are_capped_and_report_the_remaining_rows() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let variants: Vec<RootVariant> = (1..=250)
            .map(|position| observed_variant("1", position))
            .collect();
        insert_root_variants(&project, &variants);

        let first = project.variant_page(&working.id, 0, u32::MAX).unwrap();
        assert_eq!(first.limit, VARIANT_PAGE_SIZE);
        assert_eq!(first.variants.len(), VARIANT_PAGE_SIZE as usize);
        assert_eq!(first.total, 250);
        assert!(first.has_more);
        assert_eq!(first.variants.first().unwrap().key.position, 1);
        assert_eq!(first.variants.last().unwrap().key.position, 200);

        let last = project
            .variant_page(&working.id, u64::from(VARIANT_PAGE_SIZE), u32::MAX)
            .unwrap();
        assert_eq!(last.variants.len(), 50);
        assert!(!last.has_more);
        assert_eq!(last.variants.first().unwrap().key.position, 201);
        assert_eq!(last.variants.last().unwrap().key.position, 250);
    }

    #[test]
    fn transport_steps_in_canonical_contig_order_and_wraps() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        insert_root_variants(
            &project,
            &[
                observed_variant("10", 20),
                observed_variant("2", 30),
                observed_variant("X", 40),
            ],
        );
        let selection = VariantSelection::AllTrack {
            track_id: working.id,
            exclusions: Vec::new(),
        };
        let first = project
            .transport_target(&TransportTargetRequest {
                selection: selection.clone(),
                target_kind: TransportTargetKind::Variants,
                action: TransportAction::First,
                cursor: None,
                wrap: false,
            })
            .unwrap()
            .target
            .unwrap();
        assert_eq!(first.source_key.contig, "2");
        assert_eq!((first.ordinal, first.total), (1, 3));
        let previous = project
            .transport_target(&TransportTargetRequest {
                selection,
                target_kind: TransportTargetKind::Variants,
                action: TransportAction::Previous,
                cursor: Some(first.cursor),
                wrap: true,
            })
            .unwrap()
            .target
            .unwrap();
        assert_eq!(previous.source_key.contig, "X");
        assert!(previous.wrapped);
    }

    #[test]
    fn transport_active_edits_resolves_the_current_track_allele() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let source = observed_variant("1", 100);
        insert_root_variants(&project, std::slice::from_ref(&source));
        project
            .apply_edit_to_track(
                &working.id,
                Haplotype::One,
                EditKind::SetAllele {
                    key: VariantKey {
                        alternate: "G".into(),
                        ..source.key.clone()
                    },
                    source_key: Some(source.key.clone()),
                    unphased_slot: None,
                },
                Some("transport test".into()),
            )
            .unwrap();
        let target = project
            .transport_target(&TransportTargetRequest {
                selection: VariantSelection::AllTrack {
                    track_id: working.id,
                    exclusions: Vec::new(),
                },
                target_kind: TransportTargetKind::ActiveEdits,
                action: TransportAction::First,
                cursor: None,
                wrap: false,
            })
            .unwrap()
            .target
            .unwrap();
        assert_eq!(target.source_key.alternate, "C");
        assert_eq!(target.current_variant.unwrap().key.alternate, "G");
        assert_eq!(target.locus_status, "alternate");
    }

    #[test]
    fn variant_navigation_groups_contigs_and_returns_only_occupied_bins() {
        let (_temporary, project) = test_project();
        let mut second_x_allele = observed_variant("X", 50);
        second_x_allele.key.alternate = "G".into();
        insert_root_variants(
            &project,
            &[
                observed_variant("10", 500),
                observed_variant("2", 10),
                observed_variant("2", 20),
                observed_variant("2", 90),
                observed_variant("X", 50),
                second_x_allele,
            ],
        );

        let summaries = project.variant_contig_summaries().unwrap();
        assert_eq!(
            summaries
                .iter()
                .map(|summary| summary.contig.as_str())
                .collect::<Vec<_>>(),
            vec!["2", "10", "X"]
        );
        assert_eq!(summaries[0].total, 3);
        assert_eq!(
            (summaries[0].min_position, summaries[0].max_position),
            (10, 90)
        );
        assert_eq!(summaries[2].total, 2);

        let bins = project.variant_navigation_bins("2", 4).unwrap();
        assert_eq!(bins.len(), 2);
        assert_eq!((bins[0].start, bins[0].end, bins[0].total), (10, 20, 2));
        assert_eq!((bins[1].start, bins[1].end, bins[1].total), (90, 90, 1));
        assert_eq!(bins.iter().map(|bin| bin.total).sum::<u64>(), 3);

        let nested = project
            .variant_navigation_bins_in_region("2", Some(10), Some(20), 4)
            .unwrap();
        assert_eq!(nested.len(), 2);
        assert_eq!((nested[0].start, nested[0].end), (10, 10));
        assert_eq!((nested[1].start, nested[1].end), (20, 20));

        let single_position = project.variant_navigation_bins("X", 24).unwrap();
        assert_eq!(single_position.len(), 1);
        assert_eq!(
            (
                single_position[0].start,
                single_position[0].end,
                single_position[0].total,
            ),
            (50, 50, 2)
        );
        assert!(project
            .variant_navigation_bins("missing", 24)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn density_always_returns_the_fixed_bin_grid() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        insert_root_variants(
            &project,
            &[
                observed_variant("1", 1),
                observed_variant("1", 128),
                observed_variant("1", 256),
                observed_variant("2", 128),
            ],
        );

        let density = project
            .variant_density(
                &working.id,
                FocusContext {
                    contig: "1".into(),
                    start: 1,
                    end: 256,
                },
            )
            .unwrap();
        assert_eq!(density.bins.len(), VARIANT_DENSITY_BINS as usize);
        assert_eq!(density.total, 3);
        assert_eq!(density.bins.iter().map(|bin| bin.count).sum::<u64>(), 3);
        assert_eq!((density.bins[0].start, density.bins[0].end), (1, 1));
        assert_eq!(
            (
                density.bins.last().unwrap().start,
                density.bins.last().unwrap().end,
            ),
            (256, 256)
        );
    }

    #[test]
    fn wide_dense_focus_uses_density_mode_instead_of_truncating_alleles() {
        let (_temporary, project) = test_project();
        let variants: Vec<RootVariant> = (1..=600)
            .map(|index| observed_variant("1", index * 10_000))
            .collect();
        insert_root_variants(&project, &variants);

        let context = FocusContext {
            contig: "1".into(),
            start: 1,
            end: 10_000_000,
        };
        assert_eq!(
            project.source_variant_count_in_context(&context).unwrap(),
            600
        );
        let focus = project.focus_view(context).unwrap();
        assert!(focus.variants.is_empty());
        assert!(focus.reference_sequence.is_none());
        assert!(focus.haplotype1_sequence.is_none());
        assert!(focus.haplotype2_sequence.is_none());
        assert!(focus
            .warnings
            .iter()
            .any(|warning| warning.contains("density mode")));
    }

    #[test]
    fn symbolic_selections_resolve_exclusions_and_report_truncation() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let variants: Vec<RootVariant> = (1..=10)
            .map(|position| observed_variant("1", position))
            .collect();
        insert_root_variants(&project, &variants);
        insert_root_variants(
            &project,
            &[observed_variant("2", 100), observed_variant("X", 200)],
        );

        let interval = project
            .resolve_selection(
                &VariantSelection::Interval {
                    track_id: working.id.clone(),
                    contig: "1".into(),
                    start: 3,
                    end: 8,
                    exclusions: vec![variants[4].key.clone()],
                },
                3,
            )
            .unwrap();
        assert_eq!(interval.total, 5);
        assert_eq!(interval.limit, 3);
        assert!(interval.truncated);
        assert_eq!(
            interval
                .variants
                .iter()
                .map(|key| key.position)
                .collect::<Vec<_>>(),
            vec![3, 4, 6]
        );

        let all_track = project
            .resolve_selection(
                &VariantSelection::AllTrack {
                    track_id: working.id.clone(),
                    exclusions: vec![variants[1].key.clone()],
                },
                4,
            )
            .unwrap();
        assert_eq!(all_track.total, 11);
        assert!(all_track.truncated);
        assert_eq!(
            all_track
                .variants
                .iter()
                .map(|key| key.position)
                .collect::<Vec<_>>(),
            vec![1, 3, 4, 5]
        );
    }

    #[test]
    fn invalid_edit_late_in_a_batch_leaves_the_track_unchanged() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let head_before = working.head_state_id.clone();
        let state_count_before = project.states().unwrap().len();
        let absent_source = VariantKey {
            assembly: "b37".into(),
            contig: "1".into(),
            position: 999,
            reference: "A".into(),
            alternate: "C".into(),
        };
        let invalid_replacement = EditKind::SetAllele {
            key: VariantKey {
                alternate: "G".into(),
                ..absent_source.clone()
            },
            source_key: Some(absent_source),
            unphased_slot: None,
        };

        let error = project
            .apply_edits_to_track(
                &working.id,
                &[
                    (
                        Haplotype::One,
                        create_allele(100, "T"),
                        Some("valid first operation".into()),
                    ),
                    (
                        Haplotype::One,
                        invalid_replacement,
                        Some("invalid second operation".into()),
                    ),
                ],
            )
            .unwrap_err();
        assert!(error.to_string().contains("replacement source is absent"));
        assert_eq!(
            project.track(&working.id).unwrap().head_state_id,
            head_before
        );
        assert_eq!(project.states().unwrap().len(), state_count_before);
        assert!(project.edits_for_track(&working.id).unwrap().is_empty());
        assert!(project
            .effective_variants_for_track(&working.id)
            .unwrap()
            .is_empty());
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
                substitution_pattern: Default::default(),
                transition_probability: 67,
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
                    Some("Mutation Generator · Randomizer mode · seed 42 · amount 100%".into()),
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
    fn track_profile_fingerprint_is_reusable_across_unchanged_duplicates() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let state = project
            .apply_edit_to_track(
                &working.id,
                Haplotype::One,
                create_allele(100, "T"),
                Some("profiled edit".into()),
            )
            .unwrap();
        let duplicate = project
            .duplicate_track(&working.id, "Profile-compatible duplicate")
            .unwrap();
        let devices = vec![
            "org.dgw.builtin.variant-consequences".to_string(),
            "org.dgw.builtin.clinvar".to_string(),
        ];

        let original_fingerprint = project
            .track_profile_input_fingerprint(&working.id, &devices)
            .unwrap();
        assert_eq!(
            project
                .track_profile_input_fingerprint(&duplicate.id, &devices)
                .unwrap(),
            original_fingerprint
        );
        let mut reversed_devices = devices.clone();
        reversed_devices.reverse();
        assert_eq!(
            project
                .track_profile_input_fingerprint(&duplicate.id, &reversed_devices)
                .unwrap(),
            original_fingerprint
        );
        assert_ne!(
            project
                .track_profile_input_fingerprint(&duplicate.id, &devices[..1])
                .unwrap(),
            original_fingerprint
        );

        project
            .toggle_track_edit_bypass(&duplicate.id, state.edit_id.as_deref().unwrap(), true)
            .unwrap();
        assert_ne!(
            project
                .track_profile_input_fingerprint(&duplicate.id, &devices)
                .unwrap(),
            original_fingerprint
        );
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
    fn toggles_an_edit_batch_as_one_reversible_track_operation() {
        let (_temporary, project) = test_project();
        let working = project.active_track().unwrap();
        let first = project
            .apply_edit_to_track(&working.id, Haplotype::One, create_allele(100, "T"), None)
            .unwrap()
            .edit_id
            .unwrap();
        let second = project
            .apply_edit_to_track(&working.id, Haplotype::Two, create_allele(200, "G"), None)
            .unwrap()
            .edit_id
            .unwrap();
        let edit_ids = vec![first, second];

        project
            .toggle_track_edits_bypass(&working.id, &edit_ids, true)
            .unwrap();
        assert!(project
            .effective_variants_for_track(&working.id)
            .unwrap()
            .is_empty());

        project
            .toggle_track_edits_bypass(&working.id, &edit_ids, false)
            .unwrap();
        assert_eq!(
            project
                .effective_variants_for_track(&working.id)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn source_is_protected_and_active_track_deletion_selects_a_fallback() {
        let (_temporary, project) = test_project();
        let tracks = project.list_tracks().unwrap();
        let source = tracks.iter().find(|track| track.read_only).unwrap().clone();
        let working = tracks
            .iter()
            .find(|track| !track.read_only)
            .unwrap()
            .clone();

        assert!(project.delete_track(&source.id).is_err());

        let duplicate = project.duplicate_track(&working.id, "Disposable").unwrap();
        project.delete_track(&duplicate.id).unwrap();
        assert_eq!(project.active_track().unwrap().id, working.id);
        assert!(!project
            .list_tracks()
            .unwrap()
            .iter()
            .any(|track| track.id == duplicate.id));

        project.delete_track(&working.id).unwrap();
        assert_eq!(project.active_track().unwrap().id, source.id);
        assert!(project
            .list_tracks()
            .unwrap()
            .iter()
            .all(|track| track.read_only));
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
    fn export_streams_large_root_and_keeps_only_dgw_info() {
        let (temporary, project) = test_project();
        let roots: Vec<RootVariant> = (1..=2_000)
            .map(|position| {
                let mut variant = observed_variant("1", position);
                variant.id = Some(format!("rs{position}"));
                variant.quality = Some("42".into());
                variant
                    .info
                    .insert("ANN".into(), "C|missense_variant|HIGH|IMPORTED_ONLY".into());
                variant.info.insert("CLNSIG".into(), "Pathogenic".into());
                if position == 1 {
                    variant.filter = "LowQual".into();
                }
                variant
            })
            .collect();
        insert_root_variants(&project, &roots);

        // A legacy annotated header remains in the frozen source artifact but
        // must not enter the clean rendered VCF.
        let selected_vcf =
            File::create(project.root.join("artifacts/root.selected.vcf.gz")).unwrap();
        let mut selected_vcf =
            flate2::write::GzEncoder::new(selected_vcf, flate2::Compression::default());
        selected_vcf
            .write_all(
                b"##fileformat=VCFv4.3\n##contig=<ID=1>\n##FILTER=<ID=LowQual,Description=\"fixture\">\n##INFO=<ID=ANN,Number=.,Type=String,Description=\"imported\">\n##INFO=<ID=CLNSIG,Number=.,Type=String,Description=\"imported\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tTEST\n",
            )
            .unwrap();
        selected_vcf.finish().unwrap();

        let working = project.active_track().unwrap();
        let replacement_source = roots[999].key.clone();
        project
            .apply_edit_to_track(
                &working.id,
                Haplotype::One,
                EditKind::SetAllele {
                    key: VariantKey {
                        alternate: "G".into(),
                        ..replacement_source.clone()
                    },
                    source_key: Some(replacement_source),
                    unphased_slot: None,
                },
                Some("streamed replacement".into()),
            )
            .unwrap();
        project
            .apply_edit_to_track(
                &working.id,
                Haplotype::One,
                EditKind::RestoreReference {
                    source_key: roots[1_499].key.clone(),
                },
                Some("streamed restoration".into()),
            )
            .unwrap();
        project
            .apply_edit_to_track(
                &working.id,
                Haplotype::Unphased,
                create_allele(2_500, "T"),
                Some("streamed creation".into()),
            )
            .unwrap();

        let cached = EvaluationResult {
            variant: roots[0].key.clone(),
            cache_key: "fixture-evaluation".into(),
            consequence: EvidenceResult {
                source: "Variant Consequences".into(),
                status: EvidenceStatus::NoExactMatch,
                records: Vec::new(),
                message: None,
            },
            clinvar: EvidenceResult {
                source: "ClinVar".into(),
                status: EvidenceStatus::NoExactMatch,
                records: Vec::new(),
                message: None,
            },
            cosmic: EvidenceResult {
                source: "COSMIC".into(),
                status: EvidenceStatus::NoExactMatch,
                records: Vec::new(),
                message: None,
            },
            evaluated_at: Utc::now(),
            resource_bundle_fingerprint: "bundle-sha".into(),
            limitation: "fixture".into(),
        };
        project.cache_put(&cached).unwrap();

        let rendered_path = project
            .render_track(&working.id, temporary.path().join("streamed.vcf.gz"))
            .unwrap();
        let mut rendered = String::new();
        MultiGzDecoder::new(File::open(&rendered_path).unwrap())
            .read_to_string(&mut rendered)
            .unwrap();
        assert!(rendered.contains("##FILTER=<ID=LowQual"));
        assert!(!rendered.contains("##INFO=<ID=ANN"));
        assert!(!rendered.contains("##INFO=<ID=CLNSIG"));
        let records: Vec<Vec<&str>> = rendered
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split('\t').collect())
            .collect();
        assert_eq!(records.len(), 2_000);
        assert_eq!(&records[0][2..7], &["rs1", "A", "C", "42", "LowQual"]);
        assert!(records
            .iter()
            .all(|fields| !fields[7].contains("ANN") && !fields[7].contains("CLNSIG")));
        let replacement = records.iter().find(|fields| fields[1] == "1000").unwrap();
        assert_eq!(&replacement[2..7], &[".", "A", "G", ".", "PASS"]);
        assert!(!records.iter().any(|fields| fields[1] == "1500"));
        let created = records.iter().find(|fields| fields[1] == "2500").unwrap();
        assert_eq!(created[4], "T");
        assert_eq!(created[9], "0/1");

        let evidence_path = PathBuf::from(format!("{}.evidence.json.gz", rendered_path.display()));
        let evidence: serde_json::Value =
            serde_json::from_reader(MultiGzDecoder::new(File::open(evidence_path).unwrap()))
                .unwrap();
        assert_eq!(evidence["coverage"]["cachedExactAlleleEntries"], 1);
        assert_eq!(evidence["evaluations"].as_array().unwrap().len(), 1);
        assert_eq!(evidence["evaluations"][0]["cacheKey"], "fixture-evaluation");
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

    #[test]
    fn workstation_session_round_trips_through_project_database() {
        let (_temporary, project) = test_project();
        assert!(project.workstation_session().unwrap().is_none());

        let session = serde_json::json!({
            "schemaVersion": 1,
            "context": {
                "contig": "1",
                "position": 200,
                "window": 500
            },
            "selectedAlleleIds": ["b37:1:200:A:T"],
            "selectedEditId": "edit-restored",
            "hiddenTrackIds": ["track-2"]
        });
        let updated_at = project.save_workstation_session(&session).unwrap();

        assert!(!updated_at.is_empty());
        assert_eq!(
            project.workstation_session().unwrap(),
            Some(session.clone())
        );
        let reopened = Project::open(project.root()).unwrap();
        assert_eq!(reopened.workstation_session().unwrap(), Some(session));
    }

    #[test]
    fn save_copy_creates_a_portable_independent_project_snapshot() {
        let (temporary, project) = test_project();
        let session = serde_json::json!({
            "schemaVersion": 1,
            "context": { "contig": "1", "position": 100, "window": 1000 }
        });
        project.save_workstation_session(&session).unwrap();
        fs::create_dir_all(project.root.join("exports")).unwrap();
        fs::write(project.root.join("exports/example.txt"), "snapshot export").unwrap();

        let destination = temporary.path().join("analysis-copy.dgw");
        let copied = project.save_copy(&destination).unwrap();

        assert_eq!(copied.root(), destination);
        assert_ne!(copied.manifest().project_id, project.manifest().project_id);
        assert_eq!(
            copied.manifest().copied_from_project_id.as_deref(),
            Some(project.manifest().project_id.as_str())
        );
        assert_eq!(copied.manifest().name, "analysis-copy");
        assert_eq!(
            copied.manifest().selected_vcf_path,
            PathBuf::from("artifacts/root.selected.vcf.gz")
        );
        assert!(destination.join("artifacts/root.selected.vcf.gz").is_file());
        assert_eq!(
            fs::read_to_string(destination.join("exports/example.txt")).unwrap(),
            "snapshot export"
        );
        assert_eq!(copied.workstation_session().unwrap(), Some(session));
        assert_eq!(
            copied.list_tracks().unwrap(),
            project.list_tracks().unwrap()
        );
    }

    #[test]
    fn rendered_exact_alt_rows_preserve_unphased_multiallelic_gt_slots() {
        let mut output = Vec::new();
        for (alternate, slot) in [("C", 1), ("G", 2)] {
            let variant = EffectiveVariant {
                key: VariantKey {
                    assembly: "b37".into(),
                    contig: "1".into(),
                    position: 100,
                    reference: "A".into(),
                    alternate: alternate.into(),
                },
                haplotype1_alt: false,
                haplotype2_alt: false,
                unphased_alt: true,
                unphased_slot: Some(slot),
                origin: VariantOrigin::Observed,
                edit_ids: Vec::new(),
                source_key: None,
                source_info: BTreeMap::new(),
            };
            write_rendered_variant(&mut output, &variant, None).unwrap();
        }
        let rendered = String::from_utf8(output).unwrap();
        assert!(rendered.lines().any(|line| line.ends_with("GT\t1/0")));
        assert!(rendered.lines().any(|line| line.ends_with("GT\t0/1")));
    }
}
