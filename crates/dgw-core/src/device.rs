//! Versioned, language-neutral contracts for DGW devices.
//!
//! Devices receive one JSON request and return one JSON response. Editing
//! devices may propose ordinary DGW edits, but this protocol deliberately has
//! no project path, state pointer, track pointer, or mutation command. The host
//! reviews and applies proposals through the normal project API.

use crate::error::{DgwError, Result};
use crate::model::{EditKind, Haplotype};
use crate::state::validate_edit_shape;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};

pub const DGW_DEVICE_MANIFEST_SUFFIX: &str = ".dgw-device.json";
pub const DGW_DEVICE_MANIFEST_VERSION: &str = "1.0";
pub const DGW_DEVICE_PROTOCOL_VERSION: &str = "1.0";

pub const ALLELE_INPUT_SCHEMA_ID: &str = "org.dgw.schema.allele.v1";
pub const FOCUSED_TRACK_INPUT_SCHEMA_ID: &str = "org.dgw.schema.focused-track.v1";
pub const ANNOTATION_OUTPUT_SCHEMA_ID: &str = "org.dgw.schema.allele-annotations.v1";
pub const EVIDENCE_OUTPUT_SCHEMA_ID: &str = "org.dgw.schema.allele-evidence.v1";
pub const EDIT_PROPOSALS_OUTPUT_SCHEMA_ID: &str = "org.dgw.schema.edit-proposals.v1";
pub const VISUALIZATION_OUTPUT_SCHEMA_ID: &str = "org.dgw.schema.track-visualization.v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum DeviceKind {
    Analysis,
    Evidence,
    Editing,
    Visualization,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum DeviceCapability {
    AnalyzeAllele,
    LookupEvidence,
    ProposeEdits,
    VisualizeTrack,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeviceResourceKind {
    ReferenceGenome,
    TranscriptAnnotation,
    VariantDatabase,
    ScoringDataset,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResourceRequirement {
    pub id: String,
    pub kind: DeviceResourceKind,
    pub required: bool,
    pub assembly_specific: bool,
    pub description: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum DevicePermission {
    ReadDeclaredResources,
    WriteTemporaryFiles,
    NetworkAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum DeviceExecution {
    BuiltIn,
    ExternalProcess {
        entrypoint: String,
        #[serde(default)]
        arguments: Vec<String>,
        permissions: Vec<DevicePermission>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceManifest {
    pub manifest_version: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub kind: DeviceKind,
    pub capabilities: Vec<DeviceCapability>,
    pub protocol_version: String,
    pub supported_assemblies: Vec<String>,
    pub input_schema_ids: Vec<String>,
    pub output_schema_ids: Vec<String>,
    #[serde(default)]
    pub resource_requirements: Vec<DeviceResourceRequirement>,
    pub execution: DeviceExecution,
    pub scientific_limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDeviceManifest {
    pub path: PathBuf,
    pub manifest: DeviceManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResourceBinding {
    pub resource_id: String,
    pub release: String,
    pub location: String,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProtocolRequest {
    pub protocol_version: String,
    pub request_id: String,
    pub device_id: String,
    pub capability: DeviceCapability,
    pub assembly: String,
    pub input_schema_id: String,
    pub input: Value,
    #[serde(default)]
    pub resource_bindings: Vec<DeviceResourceBinding>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeviceResponseStatus {
    Success,
    Failure,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeviceEvidenceStatus {
    Found,
    NoExactMatch,
    NotComputed,
    ResourceUnavailable,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAnnotation {
    pub source: String,
    pub fields: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEvidence {
    pub source: String,
    pub status: DeviceEvidenceStatus,
    #[serde(default)]
    pub records: Vec<BTreeMap<String, Value>>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProposedEdit {
    pub haplotype: Haplotype,
    pub edit: EditKind,
    pub note: Option<String>,
    pub rationale: String,
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProtocolError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProtocolResponse {
    pub protocol_version: String,
    pub request_id: String,
    pub device_id: String,
    pub status: DeviceResponseStatus,
    pub output_schema_id: String,
    #[serde(default)]
    pub annotations: Vec<DeviceAnnotation>,
    #[serde(default)]
    pub evidence: Vec<DeviceEvidence>,
    #[serde(default)]
    pub proposed_edits: Vec<DeviceProposedEdit>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub scientific_limitations: Vec<String>,
    pub error: Option<DeviceProtocolError>,
}

pub fn validate_device_manifest(manifest: &DeviceManifest) -> Result<()> {
    if manifest.manifest_version != DGW_DEVICE_MANIFEST_VERSION {
        return invalid(format!(
            "{} uses unsupported manifest version {}; expected {}",
            manifest.id, manifest.manifest_version, DGW_DEVICE_MANIFEST_VERSION
        ));
    }
    validate_id("device id", &manifest.id)?;
    validate_nonempty("device name", &manifest.name)?;
    validate_nonempty("device description", &manifest.description)?;
    validate_semverish("device version", &manifest.version)?;
    validate_protocol_version(&manifest.protocol_version)?;

    let expected_capability = match manifest.kind {
        DeviceKind::Analysis => DeviceCapability::AnalyzeAllele,
        DeviceKind::Evidence => DeviceCapability::LookupEvidence,
        DeviceKind::Editing => DeviceCapability::ProposeEdits,
        DeviceKind::Visualization => DeviceCapability::VisualizeTrack,
    };
    validate_unique("capability", &manifest.capabilities)?;
    if manifest.capabilities.as_slice() != [expected_capability] {
        return invalid(format!(
            "device kind {:?} must declare only capability {:?}",
            manifest.kind, expected_capability
        ));
    }

    if manifest.supported_assemblies.is_empty() {
        return invalid("supportedAssemblies cannot be empty");
    }
    validate_unique("supported assembly", &manifest.supported_assemblies)?;
    for assembly in &manifest.supported_assemblies {
        validate_token("supported assembly", assembly)?;
    }
    validate_schema_ids("inputSchemaIds", &manifest.input_schema_ids)?;
    validate_schema_ids("outputSchemaIds", &manifest.output_schema_ids)?;

    let mut resource_ids = BTreeSet::new();
    for resource in &manifest.resource_requirements {
        validate_id("resource id", &resource.id)?;
        validate_nonempty("resource description", &resource.description)?;
        if !resource_ids.insert(resource.id.as_str()) {
            return invalid(format!("duplicate resource id {}", resource.id));
        }
    }

    match &manifest.execution {
        DeviceExecution::BuiltIn => {}
        DeviceExecution::ExternalProcess {
            entrypoint,
            arguments,
            permissions,
        } => {
            validate_external_entrypoint(entrypoint)?;
            if arguments.iter().any(|argument| argument.contains('\0')) {
                return invalid("external process arguments cannot contain NUL bytes");
            }
            validate_unique("permission", permissions)?;
            if !manifest.resource_requirements.is_empty()
                && !permissions.contains(&DevicePermission::ReadDeclaredResources)
            {
                return invalid(
                    "an external device with resource requirements must declare readDeclaredResources permission",
                );
            }
        }
    }

    if manifest.scientific_limitations.is_empty() {
        return invalid("scientificLimitations cannot be empty");
    }
    for limitation in &manifest.scientific_limitations {
        validate_nonempty("scientific limitation", limitation)?;
    }
    Ok(())
}

pub fn load_device_manifest(path: impl AsRef<Path>) -> Result<DeviceManifest> {
    let path = path.as_ref();
    if !is_device_manifest_path(path) {
        return invalid(format!(
            "device manifest filename must end with {DGW_DEVICE_MANIFEST_SUFFIX}: {}",
            path.display()
        ));
    }
    let manifest: DeviceManifest = serde_json::from_reader(File::open(path)?).map_err(|error| {
        DgwError::InvalidDevice(format!("cannot parse {}: {error}", path.display()))
    })?;
    validate_device_manifest(&manifest)
        .map_err(|error| DgwError::InvalidDevice(format!("{}: {error}", path.display())))?;
    Ok(manifest)
}

/// Discovers manifests below files or directories, in deterministic path order.
/// Symlinks are skipped so recursive discovery cannot leave the supplied tree.
pub fn discover_device_manifests(
    search_paths: &[PathBuf],
) -> Result<Vec<DiscoveredDeviceManifest>> {
    let mut paths = Vec::new();
    for search_path in search_paths {
        collect_manifest_paths(search_path, &mut paths)?;
    }
    paths.sort();
    paths.dedup();

    let mut ids = BTreeSet::new();
    let mut discovered = Vec::new();
    for path in paths {
        let manifest = load_device_manifest(&path)?;
        if !ids.insert(manifest.id.clone()) {
            return invalid(format!("duplicate discovered device id {}", manifest.id));
        }
        discovered.push(DiscoveredDeviceManifest { path, manifest });
    }
    Ok(discovered)
}

pub fn validate_device_request(
    manifest: &DeviceManifest,
    request: &DeviceProtocolRequest,
) -> Result<()> {
    validate_device_manifest(manifest)?;
    validate_protocol_version(&request.protocol_version)?;
    validate_token("request id", &request.request_id)?;
    if request.device_id != manifest.id {
        return invalid(format!(
            "request targets device {}, not {}",
            request.device_id, manifest.id
        ));
    }
    if !manifest.capabilities.contains(&request.capability) {
        return invalid(format!(
            "device {} does not declare capability {:?}",
            manifest.id, request.capability
        ));
    }
    if !manifest
        .supported_assemblies
        .iter()
        .any(|assembly| assembly == &request.assembly)
    {
        return invalid(format!(
            "device {} does not support assembly {}",
            manifest.id, request.assembly
        ));
    }
    if !manifest
        .input_schema_ids
        .iter()
        .any(|schema| schema == &request.input_schema_id)
    {
        return invalid(format!(
            "device {} does not accept input schema {}",
            manifest.id, request.input_schema_id
        ));
    }

    let declared: BTreeMap<&str, &DeviceResourceRequirement> = manifest
        .resource_requirements
        .iter()
        .map(|resource| (resource.id.as_str(), resource))
        .collect();
    let mut bound = BTreeSet::new();
    for binding in &request.resource_bindings {
        validate_id("bound resource id", &binding.resource_id)?;
        if !declared.contains_key(binding.resource_id.as_str()) {
            return invalid(format!(
                "request binds undeclared resource {}",
                binding.resource_id
            ));
        }
        if !bound.insert(binding.resource_id.as_str()) {
            return invalid(format!(
                "request binds resource {} more than once",
                binding.resource_id
            ));
        }
        validate_nonempty("resource release", &binding.release)?;
        validate_nonempty("resource location", &binding.location)?;
        if binding
            .fingerprint
            .as_ref()
            .is_some_and(|fingerprint| fingerprint.trim().is_empty())
        {
            return invalid("resource fingerprint cannot be empty when supplied");
        }
    }
    for requirement in declared.values().filter(|resource| resource.required) {
        if !bound.contains(requirement.id.as_str()) {
            return invalid(format!(
                "request is missing required resource {}",
                requirement.id
            ));
        }
    }
    Ok(())
}

pub fn validate_device_response(
    manifest: &DeviceManifest,
    request: &DeviceProtocolRequest,
    response: &DeviceProtocolResponse,
) -> Result<()> {
    validate_device_request(manifest, request)?;
    validate_protocol_version(&response.protocol_version)?;
    if response.request_id != request.request_id {
        return invalid("response requestId does not match the request");
    }
    if response.device_id != manifest.id {
        return invalid("response deviceId does not match the manifest");
    }
    if !manifest
        .output_schema_ids
        .iter()
        .any(|schema| schema == &response.output_schema_id)
    {
        return invalid(format!(
            "device {} does not declare output schema {}",
            manifest.id, response.output_schema_id
        ));
    }
    match response.status {
        DeviceResponseStatus::Success if response.error.is_some() => {
            return invalid("a successful device response cannot contain an error")
        }
        DeviceResponseStatus::Failure if response.error.is_none() => {
            return invalid("a failed device response must contain an error")
        }
        _ => {}
    }
    if let Some(error) = &response.error {
        validate_id("device error code", &error.code)?;
        validate_nonempty("device error message", &error.message)?;
    }

    if !response.proposed_edits.is_empty() && request.capability != DeviceCapability::ProposeEdits {
        return invalid("only proposeEdits responses may contain proposed edits");
    }
    for annotation in &response.annotations {
        validate_nonempty("annotation source", &annotation.source)?;
    }
    for evidence in &response.evidence {
        validate_nonempty("evidence source", &evidence.source)?;
    }
    for proposal in &response.proposed_edits {
        validate_edit_shape(&proposal.edit)
            .map_err(|error| DgwError::InvalidDevice(format!("invalid proposed edit: {error}")))?;
        validate_nonempty("edit proposal rationale", &proposal.rationale)?;
        if proposal.score.is_some_and(|score| !score.is_finite()) {
            return invalid("edit proposal score must be finite");
        }
    }
    for warning in &response.warnings {
        validate_nonempty("device warning", warning)?;
    }
    for limitation in &response.scientific_limitations {
        validate_nonempty("response scientific limitation", limitation)?;
    }
    Ok(())
}

pub fn snpeff_device_manifest() -> DeviceManifest {
    built_in_manifest(
        "org.dgw.builtin.snpeff",
        "SnpEff",
        "Predict transcript consequences for one normalized allele.",
        DeviceKind::Analysis,
        ALLELE_INPUT_SCHEMA_ID,
        ANNOTATION_OUTPUT_SCHEMA_ID,
        vec![resource_requirement(
            "org.dgw.resource.snpeff-data",
            DeviceResourceKind::TranscriptAnnotation,
            "Assembly-specific SnpEff transcript annotation data; release is bound at runtime.",
        )],
        vec!["Consequences are predicted independently per allele; compound and phase-dependent transcript consequences are not computed."],
    )
}

pub fn dbnsfp_device_manifest() -> DeviceManifest {
    evidence_manifest(
        "org.dgw.builtin.dbnsfp",
        "dbNSFP",
        "Look up computational prediction records for one exact normalized allele.",
        "org.dgw.resource.dbnsfp",
        DeviceResourceKind::ScoringDataset,
        "Scores are database observations and predictions, not clinical classifications; absence of an exact match is not benign evidence.",
    )
}

pub fn clinvar_device_manifest() -> DeviceManifest {
    evidence_manifest(
        "org.dgw.builtin.clinvar",
        "ClinVar",
        "Look up ClinVar evidence for one exact normalized allele.",
        "org.dgw.resource.clinvar",
        DeviceResourceKind::VariantDatabase,
        "ClinVar assertions require expert interpretation; absence of an exact match is not benign evidence.",
    )
}

pub fn cosmic_device_manifest() -> DeviceManifest {
    evidence_manifest(
        "org.dgw.builtin.cosmic",
        "COSMIC",
        "Look up COSMIC records for one exact normalized allele.",
        "org.dgw.resource.cosmic",
        DeviceResourceKind::VariantDatabase,
        "COSMIC reports observed somatic records and does not establish germline disease causality; absence of an exact match is not benign evidence.",
    )
}

pub fn genome_optimizer_device_manifest() -> DeviceManifest {
    built_in_manifest(
        "org.dgw.builtin.genome-optimizer",
        "Genome Optimizer",
        "Propose a bounded, reviewable set of edits for the focused track region.",
        DeviceKind::Editing,
        FOCUSED_TRACK_INPUT_SCHEMA_ID,
        EDIT_PROPOSALS_OUTPUT_SCHEMA_ID,
        Vec::new(),
        vec!["Scores are additive, allele-independent model outputs. The device does not calculate joint transcript, protein, penetrance, or disease consequences and never mutates a project directly."],
    )
}

pub fn mutation_generator_device_manifest() -> DeviceManifest {
    built_in_manifest(
        "org.dgw.builtin.mutation-generator",
        "Mutation Generator",
        "Generate mutation proposals for selected alleles using a chosen mode.",
        DeviceKind::Editing,
        FOCUSED_TRACK_INPUT_SCHEMA_ID,
        EDIT_PROPOSALS_OUTPUT_SCHEMA_ID,
        Vec::new(),
        vec!["The available Randomizer mode is not a biological prediction. Version 1 changes canonical SNVs only, preserves their chromosome-copy placement, and requires each result to be evaluated independently."],
    )
}

pub fn variant_map_device_manifest() -> DeviceManifest {
    built_in_manifest(
        "org.dgw.builtin.variant-map",
        "Variant Map",
        "Visualize source-relative molecular-impact changes across the focused track region.",
        DeviceKind::Visualization,
        FOCUSED_TRACK_INPUT_SCHEMA_ID,
        VISUALIZATION_OUTPUT_SCHEMA_ID,
        Vec::new(),
        vec!["Colors and vertical displacement report source-relative model output only. They do not represent health, disease, penetrance, or a combined biological effect."],
    )
}

pub fn built_in_device_manifests() -> Vec<DeviceManifest> {
    vec![
        snpeff_device_manifest(),
        dbnsfp_device_manifest(),
        clinvar_device_manifest(),
        cosmic_device_manifest(),
        mutation_generator_device_manifest(),
        genome_optimizer_device_manifest(),
        variant_map_device_manifest(),
    ]
}

/// Returns one built-in manifest by its stable device identifier.
///
/// Keeping this lookup beside the catalog gives cache callers a single source
/// of truth for the device version that produced an evidence result.
pub fn built_in_device_manifest(device_id: &str) -> Option<DeviceManifest> {
    built_in_device_manifests()
        .into_iter()
        .find(|manifest| manifest.id == device_id)
}

#[allow(clippy::too_many_arguments)]
fn built_in_manifest(
    id: &str,
    name: &str,
    description: &str,
    kind: DeviceKind,
    input_schema_id: &str,
    output_schema_id: &str,
    resource_requirements: Vec<DeviceResourceRequirement>,
    scientific_limitations: Vec<&str>,
) -> DeviceManifest {
    let capability = match kind {
        DeviceKind::Analysis => DeviceCapability::AnalyzeAllele,
        DeviceKind::Evidence => DeviceCapability::LookupEvidence,
        DeviceKind::Editing => DeviceCapability::ProposeEdits,
        DeviceKind::Visualization => DeviceCapability::VisualizeTrack,
    };
    DeviceManifest {
        manifest_version: DGW_DEVICE_MANIFEST_VERSION.into(),
        id: id.into(),
        name: name.into(),
        version: env!("CARGO_PKG_VERSION").into(),
        description: description.into(),
        kind,
        capabilities: vec![capability],
        protocol_version: DGW_DEVICE_PROTOCOL_VERSION.into(),
        supported_assemblies: vec!["b37".into()],
        input_schema_ids: vec![input_schema_id.into()],
        output_schema_ids: vec![output_schema_id.into()],
        resource_requirements,
        execution: DeviceExecution::BuiltIn,
        scientific_limitations: scientific_limitations
            .into_iter()
            .map(str::to_owned)
            .collect(),
    }
}

fn evidence_manifest(
    id: &str,
    name: &str,
    description: &str,
    resource_id: &str,
    resource_kind: DeviceResourceKind,
    limitation: &str,
) -> DeviceManifest {
    built_in_manifest(
        id,
        name,
        description,
        DeviceKind::Evidence,
        ALLELE_INPUT_SCHEMA_ID,
        EVIDENCE_OUTPUT_SCHEMA_ID,
        vec![resource_requirement(
            resource_id,
            resource_kind,
            "Assembly-specific indexed resource; release and fingerprint are bound at runtime.",
        )],
        vec![limitation],
    )
}

fn resource_requirement(
    id: &str,
    kind: DeviceResourceKind,
    description: &str,
) -> DeviceResourceRequirement {
    DeviceResourceRequirement {
        id: id.into(),
        kind,
        // Evidence resources are optional at the workstation level. A built-in
        // device remains present in the rack when its binding is absent and
        // reports ResourceUnavailable when invoked. External devices can still
        // declare hard requirements in their own manifests.
        required: false,
        assembly_specific: true,
        description: description.into(),
    }
}

fn collect_manifest_paths(path: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_file() {
        if is_device_manifest_path(path) {
            paths.push(path.to_path_buf());
        }
        return Ok(());
    }
    if !metadata.is_dir() {
        return Ok(());
    }
    let mut entries = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        collect_manifest_paths(&entry.path(), paths)?;
    }
    Ok(())
}

fn is_device_manifest_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.len() > DGW_DEVICE_MANIFEST_SUFFIX.len()
                && name.ends_with(DGW_DEVICE_MANIFEST_SUFFIX)
        })
}

fn validate_external_entrypoint(entrypoint: &str) -> Result<()> {
    validate_nonempty("external process entrypoint", entrypoint)?;
    if entrypoint.contains('\0') || entrypoint.contains('\\') || entrypoint.contains(':') {
        return invalid("external process entrypoint must use a relative portable path");
    }
    let path = Path::new(entrypoint);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::CurDir
                    | Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
        || path.file_name().is_none()
    {
        return invalid("external process entrypoint must be a contained relative path");
    }
    Ok(())
}

fn validate_schema_ids(label: &str, schema_ids: &[String]) -> Result<()> {
    if schema_ids.is_empty() {
        return invalid(format!("{label} cannot be empty"));
    }
    validate_unique("schema id", schema_ids)?;
    for schema_id in schema_ids {
        validate_id("schema id", schema_id)?;
    }
    Ok(())
}

fn validate_protocol_version(version: &str) -> Result<()> {
    validate_semverish("protocol version", version)?;
    let expected = version_numbers(DGW_DEVICE_PROTOCOL_VERSION)?;
    let supplied = version_numbers(version)?;
    if supplied.0 != expected.0 || supplied.1 > expected.1 {
        return invalid(format!(
            "protocol version {version} is incompatible with host protocol {DGW_DEVICE_PROTOCOL_VERSION}"
        ));
    }
    Ok(())
}

fn validate_semverish(_label: &str, version: &str) -> Result<()> {
    let (major, minor, patch) = version_numbers(version)?;
    let _ = (major, minor, patch);
    Ok(())
}

fn version_numbers(version: &str) -> Result<(u64, u64, Option<u64>)> {
    if version.is_empty() || version.contains(char::is_whitespace) {
        return invalid(format!("invalid semver-like version {version}"));
    }
    let (without_build, build) = version
        .split_once('+')
        .map_or((version, None), |(core, suffix)| (core, Some(suffix)));
    if without_build.contains('+')
        || build.is_some_and(|suffix| suffix.contains('+') || !valid_version_suffix(suffix))
    {
        return invalid(format!("invalid semver-like version {version}"));
    }
    let (core, prerelease) = without_build
        .split_once('-')
        .map_or((without_build, None), |(core, suffix)| (core, Some(suffix)));
    if prerelease.is_some_and(|suffix| !valid_version_suffix(suffix)) {
        return invalid(format!("invalid semver-like version {version}"));
    }
    let parts: Vec<&str> = core.split('.').collect();
    if !(2..=3).contains(&parts.len())
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return invalid(format!("invalid semver-like version {version}"));
    }
    let parse = |part: &str| {
        part.parse::<u64>()
            .map_err(|_| DgwError::InvalidDevice(format!("invalid version component {part}")))
    };
    Ok((
        parse(parts[0])?,
        parse(parts[1])?,
        parts.get(2).map(|part| parse(part)).transpose()?,
    ))
}

fn valid_version_suffix(suffix: &str) -> bool {
    !suffix.is_empty()
        && suffix.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn validate_id(label: &str, id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 160 {
        return invalid(format!("{label} must contain 1-160 characters"));
    }
    if !id
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-_".contains(&byte))
        || !id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        || !id.as_bytes().last().is_some_and(u8::is_ascii_alphanumeric)
        || id.contains("..")
    {
        return invalid(format!(
            "{label} must be a lowercase dotted identifier using letters, digits, '.', '-', or '_'"
        ));
    }
    Ok(())
}

fn validate_token(label: &str, token: &str) -> Result<()> {
    if token.is_empty()
        || token.len() > 160
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':'))
    {
        return invalid(format!("{label} contains unsupported characters"));
    }
    Ok(())
}

fn validate_nonempty(label: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return invalid(format!("{label} cannot be empty"));
    }
    Ok(())
}

fn validate_unique<T: Ord + std::fmt::Debug>(label: &str, values: &[T]) -> Result<()> {
    let mut unique = BTreeSet::new();
    for value in values {
        if !unique.insert(value) {
            return invalid(format!("duplicate {label}: {value:?}"));
        }
    }
    Ok(())
}

fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(DgwError::InvalidDevice(message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::VariantKey;
    use pretty_assertions::assert_eq;
    use tempfile::tempdir;

    fn resource_bindings(manifest: &DeviceManifest) -> Vec<DeviceResourceBinding> {
        manifest
            .resource_requirements
            .iter()
            .filter(|resource| resource.required)
            .map(|resource| DeviceResourceBinding {
                resource_id: resource.id.clone(),
                release: "runtime-release-2026-08".into(),
                location: format!("file:///configured/{}", resource.id),
                fingerprint: Some("sha256:0123456789abcdef".into()),
            })
            .collect()
    }

    fn request_for(manifest: &DeviceManifest) -> DeviceProtocolRequest {
        DeviceProtocolRequest {
            protocol_version: DGW_DEVICE_PROTOCOL_VERSION.into(),
            request_id: "request-123".into(),
            device_id: manifest.id.clone(),
            capability: manifest.capabilities[0],
            assembly: manifest.supported_assemblies[0].clone(),
            input_schema_id: manifest.input_schema_ids[0].clone(),
            input: serde_json::json!({
                "assembly": "b37",
                "contig": "7",
                "position": 140453136,
                "reference": "A",
                "alternate": "T"
            }),
            resource_bindings: resource_bindings(manifest),
        }
    }

    fn proposed_edit() -> DeviceProposedEdit {
        DeviceProposedEdit {
            haplotype: Haplotype::Unphased,
            edit: EditKind::SetAllele {
                key: VariantKey {
                    assembly: "b37".into(),
                    contig: "7".into(),
                    position: 140453136,
                    reference: "A".into(),
                    alternate: "T".into(),
                },
                source_key: None,
            },
            note: Some("device proposal; not yet applied".into()),
            rationale: "Lowest bounded additive score among permitted alleles.".into(),
            score: Some(-0.25),
        }
    }

    #[test]
    fn built_in_catalog_is_valid_and_resource_releases_are_runtime_bindings() {
        let manifests = built_in_device_manifests();
        assert_eq!(manifests.len(), 7);
        let mut ids = BTreeSet::new();
        for manifest in &manifests {
            validate_device_manifest(manifest).unwrap();
            assert!(ids.insert(&manifest.id));
            assert_eq!(manifest.version, env!("CARGO_PKG_VERSION"));
            assert_eq!(manifest.execution, DeviceExecution::BuiltIn);
            let json = serde_json::to_value(manifest).unwrap();
            for resource in json["resourceRequirements"].as_array().unwrap() {
                assert!(resource.get("release").is_none());
            }
        }

        assert_eq!(manifests[0].kind, DeviceKind::Analysis);
        assert!(manifests[1..4]
            .iter()
            .all(|manifest| manifest.kind == DeviceKind::Evidence));
        assert!(manifests[4..6]
            .iter()
            .all(|manifest| manifest.kind == DeviceKind::Editing));
        assert_eq!(manifests[4].kind, DeviceKind::Editing);
        assert_eq!(manifests[6].kind, DeviceKind::Visualization);
        assert!(manifests[4].resource_requirements.is_empty());
        assert!(manifests[..4].iter().all(|manifest| manifest
            .resource_requirements
            .iter()
            .all(|resource| !resource.required)));
        assert_eq!(
            built_in_device_manifest("org.dgw.builtin.clinvar").map(|manifest| manifest.name),
            Some("ClinVar".into())
        );
        assert!(built_in_device_manifest("org.example.missing").is_none());
    }

    #[test]
    fn manifest_validation_enforces_kind_schema_version_and_resource_ids() {
        let mut manifest = snpeff_device_manifest();
        manifest.kind = DeviceKind::Evidence;
        assert!(validate_device_manifest(&manifest)
            .unwrap_err()
            .to_string()
            .contains("LookupEvidence"));

        let mut manifest = snpeff_device_manifest();
        manifest.version = "version one".into();
        assert!(validate_device_manifest(&manifest).is_err());

        let mut manifest = snpeff_device_manifest();
        manifest.protocol_version = "2.0".into();
        assert!(validate_device_manifest(&manifest)
            .unwrap_err()
            .to_string()
            .contains("incompatible"));

        let mut manifest = snpeff_device_manifest();
        manifest.input_schema_ids = vec!["Schema.With.Uppercase".into()];
        assert!(validate_device_manifest(&manifest).is_err());

        let mut manifest = snpeff_device_manifest();
        manifest
            .resource_requirements
            .push(manifest.resource_requirements.first().unwrap().clone());
        assert!(validate_device_manifest(&manifest)
            .unwrap_err()
            .to_string()
            .contains("duplicate resource"));
    }

    #[test]
    fn external_process_requires_contained_entrypoint_and_explicit_resource_permission() {
        let mut manifest = clinvar_device_manifest();
        manifest.id = "org.example.clinvar-device".into();
        manifest.execution = DeviceExecution::ExternalProcess {
            entrypoint: "bin/clinvar-device".into(),
            arguments: vec!["--stdio".into()],
            permissions: vec![DevicePermission::ReadDeclaredResources],
        };
        validate_device_manifest(&manifest).unwrap();

        if let DeviceExecution::ExternalProcess { entrypoint, .. } = &mut manifest.execution {
            *entrypoint = "../outside/device".into();
        }
        assert!(validate_device_manifest(&manifest)
            .unwrap_err()
            .to_string()
            .contains("contained relative"));

        if let DeviceExecution::ExternalProcess {
            entrypoint,
            permissions,
            ..
        } = &mut manifest.execution
        {
            *entrypoint = "bin/device".into();
            permissions.clear();
        }
        assert!(validate_device_manifest(&manifest)
            .unwrap_err()
            .to_string()
            .contains("readDeclaredResources"));
    }

    #[test]
    fn discovery_is_recursive_deterministic_and_rejects_duplicate_ids() {
        let temporary = tempdir().unwrap();
        let nested = temporary.path().join("nested");
        fs::create_dir_all(&nested).unwrap();
        let optimizer_path = temporary.path().join("z-optimizer.dgw-device.json");
        let snpeff_path = nested.join("a-snpeff.dgw-device.json");
        fs::write(
            &optimizer_path,
            serde_json::to_vec_pretty(&genome_optimizer_device_manifest()).unwrap(),
        )
        .unwrap();
        fs::write(
            &snpeff_path,
            serde_json::to_vec_pretty(&snpeff_device_manifest()).unwrap(),
        )
        .unwrap();
        fs::write(temporary.path().join("ignored.json"), b"{}").unwrap();

        let discovered = discover_device_manifests(&[temporary.path().to_path_buf()]).unwrap();
        assert_eq!(discovered.len(), 2);
        assert!(discovered[0].path < discovered[1].path);
        assert_eq!(
            load_device_manifest(&snpeff_path).unwrap(),
            snpeff_device_manifest()
        );

        fs::write(
            nested.join("duplicate.dgw-device.json"),
            serde_json::to_vec_pretty(&snpeff_device_manifest()).unwrap(),
        )
        .unwrap();
        assert!(discover_device_manifests(&[temporary.path().to_path_buf()])
            .unwrap_err()
            .to_string()
            .contains("duplicate discovered device id"));
    }

    #[test]
    fn protocol_round_trips_proposals_without_project_mutation_commands() {
        let manifest = genome_optimizer_device_manifest();
        let request = request_for(&manifest);
        validate_device_request(&manifest, &request).unwrap();
        let response = DeviceProtocolResponse {
            protocol_version: DGW_DEVICE_PROTOCOL_VERSION.into(),
            request_id: request.request_id.clone(),
            device_id: manifest.id.clone(),
            status: DeviceResponseStatus::Success,
            output_schema_id: EDIT_PROPOSALS_OUTPUT_SCHEMA_ID.into(),
            annotations: vec![DeviceAnnotation {
                source: "optimizer scoring".into(),
                fields: BTreeMap::from([(
                    "objective".into(),
                    Value::String("predictedImpactBurden".into()),
                )]),
            }],
            evidence: vec![DeviceEvidence {
                source: "configured objective inputs".into(),
                status: DeviceEvidenceStatus::Found,
                records: Vec::new(),
                message: None,
            }],
            proposed_edits: vec![proposed_edit()],
            warnings: Vec::new(),
            scientific_limitations: manifest.scientific_limitations.clone(),
            error: None,
        };
        validate_device_response(&manifest, &request, &response).unwrap();

        let request_json = serde_json::to_string(&request).unwrap();
        let response_json = serde_json::to_string(&response).unwrap();
        assert_eq!(
            serde_json::from_str::<DeviceProtocolRequest>(&request_json).unwrap(),
            request
        );
        assert_eq!(
            serde_json::from_str::<DeviceProtocolResponse>(&response_json).unwrap(),
            response
        );
        let response_value: Value = serde_json::from_str(&response_json).unwrap();
        assert!(response_value.get("projectPath").is_none());
        assert!(response_value.get("trackId").is_none());
        assert!(response_value.get("stateId").is_none());
        assert!(response_value.get("proposedEdits").is_some());
    }

    #[test]
    fn protocol_validates_runtime_resources_and_capability_payloads() {
        let manifest = clinvar_device_manifest();
        let mut request = request_for(&manifest);
        request.resource_bindings.clear();
        validate_device_request(&manifest, &request).unwrap();

        let mut required_manifest = manifest.clone();
        required_manifest.resource_requirements[0].required = true;
        assert!(validate_device_request(&required_manifest, &request)
            .unwrap_err()
            .to_string()
            .contains("missing required resource"));

        request.resource_bindings = resource_bindings(&manifest);
        let response = DeviceProtocolResponse {
            protocol_version: DGW_DEVICE_PROTOCOL_VERSION.into(),
            request_id: request.request_id.clone(),
            device_id: manifest.id.clone(),
            status: DeviceResponseStatus::Success,
            output_schema_id: EVIDENCE_OUTPUT_SCHEMA_ID.into(),
            annotations: Vec::new(),
            evidence: vec![DeviceEvidence {
                source: "ClinVar runtime release".into(),
                status: DeviceEvidenceStatus::NoExactMatch,
                records: Vec::new(),
                message: Some("No exact normalized allele match.".into()),
            }],
            proposed_edits: Vec::new(),
            warnings: Vec::new(),
            scientific_limitations: manifest.scientific_limitations.clone(),
            error: None,
        };
        validate_device_response(&manifest, &request, &response).unwrap();

        let mut invalid_response = response;
        invalid_response.proposed_edits.push(proposed_edit());
        assert!(
            validate_device_response(&manifest, &request, &invalid_response)
                .unwrap_err()
                .to_string()
                .contains("proposeEdits")
        );
    }
}
