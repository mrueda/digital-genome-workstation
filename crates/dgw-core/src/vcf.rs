use crate::error::{DgwError, Result};
use crate::gene::gene_index_metadata;
use crate::model::{FileFingerprint, ResourceBundle, RootVariant, VariantKey, VcfInspection};
use flate2::read::MultiGzDecoder;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

fn reader_for(path: &Path) -> Result<Box<dyn BufRead>> {
    let file = File::open(path)?;
    let gzipped = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("gz"));
    if gzipped {
        Ok(Box::new(BufReader::new(MultiGzDecoder::new(file))))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

pub const CONTIG_STYLE_CHR: &str = "chr_prefix";
pub const CONTIG_STYLE_NO_CHR: &str = "no_chr_prefix";

pub fn validate_contig_style(style: &str) -> Result<()> {
    if matches!(style, CONTIG_STYLE_CHR | CONTIG_STYLE_NO_CHR) {
        Ok(())
    } else {
        Err(DgwError::InvalidResource(format!(
            "unsupported contig style '{style}'; expected chr_prefix or no_chr_prefix"
        )))
    }
}

/// Translate the two common human-reference naming conventions. This never
/// changes coordinates or assemblies.
pub fn translate_contig_style(contig: &str, target_style: &str) -> String {
    let unprefixed = contig.strip_prefix("chr").unwrap_or(contig);
    match target_style {
        CONTIG_STYLE_CHR => match unprefixed {
            "M" | "MT" => "chrM".into(),
            value => format!("chr{value}"),
        },
        CONTIG_STYLE_NO_CHR => match unprefixed {
            "M" => "MT".into(),
            value => value.into(),
        },
        _ => contig.into(),
    }
}

pub fn reference_contigs(fai_path: &Path) -> Result<BTreeSet<String>> {
    let mut contigs = BTreeSet::new();
    for line in reader_for(fai_path)?.lines() {
        let line = line?;
        if let Some(contig) = line.split('\t').next().filter(|value| !value.is_empty()) {
            contigs.insert(contig.to_owned());
        }
    }
    if contigs.is_empty() {
        return Err(DgwError::InvalidResource(format!(
            "reference FAI contains no contigs: {}",
            fai_path.display()
        )));
    }
    Ok(contigs)
}

pub fn resolve_reference_contig(contig: &str, references: &BTreeSet<String>) -> Result<String> {
    if references.contains(contig) {
        return Ok(contig.into());
    }
    let mut candidates = BTreeSet::new();
    for style in [CONTIG_STYLE_CHR, CONTIG_STYLE_NO_CHR] {
        let candidate = translate_contig_style(contig, style);
        if references.contains(&candidate) {
            candidates.insert(candidate);
        }
    }
    for candidate in ["M", "MT", "chrM"] {
        if matches!(contig, "M" | "MT" | "chrM") && references.contains(candidate) {
            candidates.insert(candidate.into());
        }
    }
    match candidates.len() {
        1 => Ok(candidates.into_iter().next().expect("one candidate")),
        0 => Err(DgwError::InvalidVcf(format!(
            "contig '{contig}' has no exact or safe alias in the configured reference"
        ))),
        _ => Err(DgwError::InvalidVcf(format!(
            "contig '{contig}' maps ambiguously in the configured reference"
        ))),
    }
}

pub fn fingerprint_file(path: &Path) -> Result<FileFingerprint> {
    let metadata = path.metadata()?;
    let modified_unix = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs());
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(FileFingerprint {
        path: path.to_path_buf(),
        sha256: hex::encode(hasher.finalize()),
        size: metadata.len(),
        modified_unix,
    })
}

fn parse_key(fields: &[&str], assembly: &str) -> Result<VariantKey> {
    if fields.len() < 5 {
        return Err(DgwError::InvalidVcf(
            "record contains fewer than five columns".into(),
        ));
    }
    let position = fields[1]
        .parse::<u64>()
        .map_err(|_| DgwError::InvalidVcf(format!("invalid position: {}", fields[1])))?;
    Ok(VariantKey {
        assembly: assembly.to_owned(),
        contig: fields[0].to_owned(),
        position,
        reference: fields[3].to_ascii_uppercase(),
        alternate: fields[4].to_ascii_uppercase(),
    })
}

fn alternate_keys(fields: &[&str], assembly: &str) -> Result<Vec<VariantKey>> {
    let record = parse_key(fields, assembly)?;
    Ok(record
        .alternate
        .split(',')
        .map(|alternate| VariantKey {
            alternate: alternate.to_owned(),
            ..record.clone()
        })
        .collect())
}

pub(crate) fn contig_rank(contig: &str) -> (u16, String) {
    let plain = contig.strip_prefix("chr").unwrap_or(contig);
    let rank = match plain {
        "X" => 23,
        "Y" => 24,
        "M" | "MT" => 25,
        _ => plain.parse::<u16>().unwrap_or(u16::MAX),
    };
    (rank, plain.to_owned())
}

pub fn inspect_vcf(path: impl AsRef<Path>, assembly: &str) -> Result<VcfInspection> {
    let path = path.as_ref();
    let mut reader = reader_for(path)?;
    let mut line = String::new();
    let mut file_format = None;
    let mut samples = Vec::new();
    let mut contigs = BTreeSet::new();
    let mut has_ann = false;
    let mut record_count = 0_u64;
    let mut pass_record_count = 0_u64;
    let mut non_pass_record_count = 0_u64;
    let mut supported_record_count = 0_u64;
    let mut skipped_unsupported_record_count = 0_u64;
    let mut biallelic = true;
    let mut sorted = true;
    let mut first_variant = None;
    let mut last_variant = None;
    let mut previous_sort_key: Option<((u16, String), u64)> = None;

    while reader.read_line(&mut line)? > 0 {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if let Some(value) = trimmed.strip_prefix("##fileformat=") {
            file_format = Some(value.to_owned());
        } else if trimmed.starts_with("##INFO=<ID=ANN,") {
            has_ann = true;
        } else if let Some(value) = trimmed.strip_prefix("##contig=<ID=") {
            if let Some(id) = value.split([',', '>']).next() {
                contigs.insert(id.to_owned());
            }
        } else if trimmed.starts_with("#CHROM") {
            let columns: Vec<&str> = trimmed.split('\t').collect();
            if columns.len() > 9 {
                samples.extend(columns[9..].iter().map(|value| (*value).to_owned()));
            }
        } else if !trimmed.starts_with('#') && !trimmed.is_empty() {
            let fields: Vec<&str> = trimmed.split('\t').collect();
            if fields.len() < 7 {
                return Err(DgwError::InvalidVcf(
                    "record contains fewer than seven required VCF columns".into(),
                ));
            }
            let keys = alternate_keys(&fields, assembly)?;
            if keys.len() > 1 {
                biallelic = false;
            }
            let supported: Vec<&VariantKey> = keys
                .iter()
                .filter(|key| is_supported_small_variant(key))
                .collect();
            let key = keys
                .first()
                .ok_or_else(|| DgwError::InvalidVcf("record has an empty ALT column".into()))?;
            let current_sort_key = (contig_rank(&key.contig), key.position);
            if previous_sort_key
                .as_ref()
                .is_some_and(|previous| previous > &current_sort_key)
            {
                sorted = false;
            }
            previous_sort_key = Some(current_sort_key);
            contigs.insert(key.contig.clone());
            if fields[6] == "PASS" {
                pass_record_count += 1;
                if !supported.is_empty() {
                    supported_record_count += 1;
                } else {
                    skipped_unsupported_record_count += 1;
                }
                if let Some(supported_key) = supported.first() {
                    if first_variant.is_none() {
                        first_variant = Some((*supported_key).clone());
                    }
                    last_variant = supported.last().map(|value| (*value).clone());
                }
            } else {
                non_pass_record_count += 1;
            }
            record_count += 1;
        }
        line.clear();
    }

    if samples.is_empty() {
        return Err(DgwError::InvalidVcf(
            "VCF has no sample columns; DGW requires GT for a selected sample".into(),
        ));
    }

    let contigs: Vec<String> = contigs.into_iter().collect();
    let prefixed = contigs
        .iter()
        .filter(|contig| contig.starts_with("chr"))
        .count();
    let input_contig_style = if prefixed == 0 {
        CONTIG_STYLE_NO_CHR
    } else if prefixed == contigs.len() {
        CONTIG_STYLE_CHR
    } else {
        "mixed"
    };
    Ok(VcfInspection {
        path: path.to_path_buf(),
        file_format,
        samples,
        contigs,
        input_contig_style: input_contig_style.into(),
        has_ann,
        record_count,
        pass_record_count,
        non_pass_record_count,
        supported_record_count,
        skipped_unsupported_record_count,
        biallelic,
        sorted,
        first_variant,
        last_variant,
    })
}

pub fn parse_info(info: &str) -> BTreeMap<String, String> {
    if info == "." || info.is_empty() {
        return BTreeMap::new();
    }
    info.split(';')
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .split_once('=')
                .map(|(key, item)| (key.to_owned(), item.to_owned()))
                .unwrap_or_else(|| (value.to_owned(), "true".to_owned()))
        })
        .collect()
}

fn is_supported_small_variant(key: &VariantKey) -> bool {
    if key.alternate.contains(',')
        || key.alternate == "."
        || key.alternate == "*"
        || key.alternate.starts_with('<')
        || key.alternate.contains('[')
        || key.alternate.contains(']')
    {
        return false;
    }
    let valid = |allele: &str| {
        !allele.is_empty()
            && allele
                .bytes()
                .all(|base| matches!(base, b'A' | b'C' | b'G' | b'T' | b'N'))
    };
    if !valid(&key.reference) || !valid(&key.alternate) || key.reference == key.alternate {
        return false;
    }
    let length_delta = key.reference.len().abs_diff(key.alternate.len());
    let is_snv = key.reference.len() == 1 && key.alternate.len() == 1;
    let is_short_indel = length_delta > 0 && length_delta < 50;
    is_snv || is_short_indel
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DiploidGt {
    alleles: [Option<usize>; 2],
    phased: bool,
}

fn parse_gt(
    format_keys: &[String],
    sample_values: &[String],
    alternate_count: usize,
) -> Result<DiploidGt> {
    let gt_index = format_keys
        .iter()
        .position(|key| key == "GT")
        .ok_or_else(|| DgwError::InvalidVcf("selected sample has no GT field".into()))?;
    let gt = sample_values
        .get(gt_index)
        .ok_or_else(|| DgwError::InvalidVcf("selected sample GT is missing".into()))?;
    if gt == "." || gt == "./." || gt == ".|." {
        return Ok(DiploidGt {
            alleles: [None, None],
            phased: gt.contains('|'),
        });
    }
    let phased = gt.contains('|');
    let alleles: Vec<&str> = gt.split(['|', '/']).collect();
    if alleles.len() != 2 {
        return Err(DgwError::InvalidVcf(format!(
            "v1 requires diploid GT, found {gt}"
        )));
    }
    let parsed = alleles
        .iter()
        .map(|value| match *value {
            "." => Ok(None),
            value => value
                .parse::<usize>()
                .map(Some)
                .map_err(|_| DgwError::InvalidVcf(format!("invalid GT allele in {gt}"))),
        })
        .collect::<Result<Vec<_>>>()?;
    if parsed
        .iter()
        .any(|value| value.is_some_and(|index| index > alternate_count))
    {
        return Err(DgwError::InvalidVcf(format!(
            "GT {gt} refers to an ALT index beyond the {alternate_count} ALT allele{} in the record",
            if alternate_count == 1 { "" } else { "s" }
        )));
    }
    if parsed.iter().filter(|value| value.is_none()).count() == 1 {
        return Err(DgwError::InvalidVcf(format!(
            "partially missing diploid GT is not supported: {gt}"
        )));
    }
    Ok(DiploidGt {
        alleles: [parsed[0], parsed[1]],
        phased,
    })
}

fn project_alt(gt: DiploidGt, alternate_index: usize) -> (bool, bool, bool, Option<u8>) {
    let first = gt.alleles[0] == Some(alternate_index);
    let second = gt.alleles[1] == Some(alternate_index);
    if gt.phased || (first && second) {
        return (first, second, false, None);
    }
    if first {
        (false, false, true, Some(1))
    } else if second {
        (false, false, true, Some(2))
    } else {
        (false, false, false, None)
    }
}

fn projected_gt(gt: DiploidGt, alternate_index: usize) -> String {
    let value = |allele: Option<usize>| match allele {
        Some(index) if index == alternate_index => "1",
        Some(_) => "0",
        None => ".",
    };
    format!(
        "{}{}{}",
        value(gt.alleles[0]),
        if gt.phased { '|' } else { '/' },
        value(gt.alleles[1])
    )
}

pub fn stream_selected_sample<F>(
    path: impl AsRef<Path>,
    assembly: &str,
    sample: &str,
    mut on_variant: F,
) -> Result<(Vec<String>, Vec<String>)>
where
    F: FnMut(&RootVariant) -> Result<()>,
{
    let mut reader = reader_for(path.as_ref())?;
    let mut line = String::new();
    let mut headers = Vec::new();
    let mut sample_index = None;
    let mut excluded_non_pass = 0_u64;
    let mut non_pass_examples = Vec::new();
    let mut skipped_unsupported = 0_u64;
    let mut skipped_examples = Vec::new();

    while reader.read_line(&mut line)? > 0 {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.starts_with("##") {
            headers.push(trimmed.to_owned());
        } else if trimmed.starts_with("#CHROM") {
            let columns: Vec<&str> = trimmed.split('\t').collect();
            sample_index = columns.iter().position(|value| *value == sample);
            if sample_index.is_none() {
                return Err(DgwError::InvalidVcf(format!(
                    "sample {sample} is not present in the VCF"
                )));
            }
        } else if !trimmed.starts_with('#') && !trimmed.is_empty() {
            let fields: Vec<&str> = trimmed.split('\t').collect();
            if fields.len() < 10 {
                return Err(DgwError::InvalidVcf(
                    "record has no FORMAT/sample columns".into(),
                ));
            }
            if fields[6] != "PASS" {
                excluded_non_pass += 1;
                if non_pass_examples.len() < 3 {
                    non_pass_examples
                        .push(format!("{}:{} FILTER={}", fields[0], fields[1], fields[6]));
                }
                line.clear();
                continue;
            }
            let keys = alternate_keys(&fields, assembly)?;
            let record_key = keys
                .first()
                .ok_or_else(|| DgwError::InvalidVcf("record has an empty ALT column".into()))?;
            // Unsupported allele classes do not enter the selected-sample
            // projection. Skip them before parsing FORMAT because CNV/SV
            // callers may use fields that do not follow the small-variant GT
            // contract required by DGW.
            if keys.iter().all(|key| !is_supported_small_variant(key)) {
                skipped_unsupported += keys.len() as u64;
                if skipped_examples.len() < 3 {
                    skipped_examples.push(record_key.display());
                }
                line.clear();
                continue;
            }

            let format_keys: Vec<String> = fields[8].split(':').map(str::to_owned).collect();
            let selected_index = sample_index.expect("#CHROM must precede records");
            let selected = fields.get(selected_index).ok_or_else(|| {
                DgwError::InvalidVcf(format!("sample column missing at {}", record_key.display()))
            })?;
            let sample_values: Vec<String> = selected.split(':').map(str::to_owned).collect();
            let gt = parse_gt(&format_keys, &sample_values, keys.len())?;
            for (offset, key) in keys.into_iter().enumerate() {
                if !is_supported_small_variant(&key) {
                    skipped_unsupported += 1;
                    if skipped_examples.len() < 3 {
                        skipped_examples.push(key.display());
                    }
                    continue;
                }
                let alternate_index = offset + 1;
                let (haplotype1_alt, haplotype2_alt, unphased_alt, unphased_slot) =
                    project_alt(gt, alternate_index);
                if !haplotype1_alt && !haplotype2_alt && !unphased_alt {
                    continue;
                }
                let multiallelic = fields[4].contains(',');
                let projected_sample_values = if multiallelic {
                    vec![projected_gt(gt, alternate_index)]
                } else {
                    sample_values.clone()
                };
                let projected_format_keys = if multiallelic {
                    vec!["GT".to_owned()]
                } else {
                    format_keys.clone()
                };
                // A multiallelic source row is frozen as exact biallelic GT-only
                // projections. Allele-indexed INFO/FORMAT values cannot safely
                // be copied after decomposition and DGW does not use them.
                let source_line = if multiallelic {
                    format!(
                        "{}\t{}\t{}\t{}\t{}\t{}\t{}\t.\tGT",
                        fields[0],
                        fields[1],
                        fields[2],
                        fields[3],
                        key.alternate,
                        fields[5],
                        fields[6]
                    )
                } else {
                    trimmed.to_owned()
                };
                let variant = RootVariant {
                    key,
                    id: (fields[2] != ".").then(|| fields[2].to_owned()),
                    quality: (fields[5] != ".").then(|| fields[5].to_owned()),
                    filter: fields[6].to_owned(),
                    info: BTreeMap::new(),
                    format_keys: projected_format_keys,
                    sample_values: projected_sample_values,
                    haplotype1_alt,
                    haplotype2_alt,
                    unphased_alt,
                    unphased_slot,
                    source_line,
                };
                on_variant(&variant)?;
            }
        }
        line.clear();
    }

    if sample_index.is_none() {
        return Err(DgwError::InvalidVcf("VCF has no #CHROM header".into()));
    }
    let mut warnings = Vec::new();
    if excluded_non_pass > 0 {
        warnings.push(format!(
            "DGW excluded {excluded_non_pass} non-PASS source VCF record{} before selected-sample projection and normalization (examples: {}). Only records whose FILTER field is exactly PASS enter a project.",
            if excluded_non_pass == 1 { "" } else { "s" },
            non_pass_examples.join(", ")
        ));
    }
    if skipped_unsupported > 0 {
        warnings.push(format!(
            "Skipped {skipped_unsupported} unsupported source VCF allele{} while projecting the selected sample (examples: {}). DGW imports each sequence-resolved SNV or 1–49 bp indel ALT as an exact internal allele.",
            if skipped_unsupported == 1 { "" } else { "s" },
            skipped_examples.join(", ")
        ));
    }
    Ok((headers, warnings))
}

pub fn extract_selected_sample(
    path: impl AsRef<Path>,
    assembly: &str,
    sample: &str,
) -> Result<(Vec<String>, Vec<RootVariant>, Vec<String>)> {
    let mut variants = Vec::new();
    let (headers, warnings) = stream_selected_sample(path, assembly, sample, |variant| {
        variants.push(variant.clone());
        Ok(())
    })?;
    Ok((headers, variants, warnings))
}

pub fn validate_resource_bundle(bundle: &ResourceBundle) -> Result<Vec<String>> {
    if bundle.schema_version != 1 {
        return Err(DgwError::InvalidResource(format!(
            "unsupported resource-bundle schema {}",
            bundle.schema_version
        )));
    }
    if !matches!(bundle.assembly.as_str(), "b37" | "hg38") {
        return Err(DgwError::InvalidResource(
            "v1 currently supports assembly b37 or hg38".into(),
        ));
    }
    validate_contig_style(&bundle.contig_style)?;
    for resource in [&bundle.clinvar, &bundle.cosmic] {
        if let Some(style) = &resource.contig_style {
            validate_contig_style(style)?;
        }
    }
    if let Some(resource) = &bundle.consequence_annotation {
        validate_contig_style(&resource.contig_style)?;
    }
    let required_files = [
        (&bundle.reference_path, "reference FASTA"),
        (&bundle.reference_fai_path, "reference FAI"),
        (&bundle.bcftools_path, "bcftools executable"),
        (&bundle.bgzip_path, "bgzip executable"),
        (&bundle.tabix_path, "tabix executable"),
    ];
    for (path, label) in required_files {
        if !path.is_file() {
            return Err(DgwError::InvalidResource(format!(
                "{label} does not exist: {}",
                path.display()
            )));
        }
    }
    let reference_names = reference_contigs(&bundle.reference_fai_path)?;
    let observed_reference_style = if reference_names.iter().any(|name| name == "chr1") {
        CONTIG_STYLE_CHR
    } else if reference_names.iter().any(|name| name == "1") {
        CONTIG_STYLE_NO_CHR
    } else {
        &bundle.contig_style
    };
    if observed_reference_style != bundle.contig_style {
        return Err(DgwError::InvalidResource(format!(
            "reference FAI uses {observed_reference_style}, but the bundle declares {}",
            bundle.contig_style
        )));
    }

    let mut warnings = Vec::new();
    if bundle.bcftools_version.trim().is_empty() {
        warnings.push(
            "The configured bcftools version is not recorded; new projects should pin it for provenance."
                .into(),
        );
    }
    if bundle.consequence_annotation.is_none() {
        warnings.push(
            "Consequence annotation GFF3 is not configured; Variant Consequences will remain unavailable."
                .into()
        );
    } else if let Some(resource) = &bundle.consequence_annotation {
        let expected_assembly = if bundle.assembly == "b37" {
            "GRCh37"
        } else {
            "GRCh38"
        };
        if resource.assembly != expected_assembly {
            return Err(DgwError::InvalidResource(format!(
                "consequence annotation assembly mismatch: project {}, resource {}",
                bundle.assembly, resource.assembly
            )));
        }
        if !resource.path.is_file() {
            warnings.push(format!(
                "{} consequence annotation is missing; Variant Consequences will remain unavailable",
                resource.release
            ));
        }
    }
    for resource in [&bundle.clinvar, &bundle.cosmic] {
        if !resource.path.is_file() || !resource.index_path.is_file() {
            warnings.push(format!(
                "{} resources are incomplete; that evidence device will remain unavailable",
                resource.release
            ));
            continue;
        }
        let data_time = resource.path.metadata()?.modified().ok();
        let index_time = resource.index_path.metadata()?.modified().ok();
        if data_time
            .zip(index_time)
            .is_some_and(|(data, index)| index < data)
        {
            warnings.push(format!(
                "{} index is older than its data file; queryability will be tested at use time",
                resource.path.display()
            ));
        }
    }
    if let Some(resource) = &bundle.gene_annotation {
        if !resource.path.is_file() || !resource.index_path.is_file() {
            warnings.push(format!(
                "{} gene annotation is incomplete; gene navigation will remain unavailable",
                resource.release
            ));
        } else {
            let metadata = gene_index_metadata(&resource.index_path)?;
            let expected_assembly = match bundle.assembly.as_str() {
                "b37" => "GRCh37",
                "hg38" | "GRCh38" => "GRCh38",
                assembly => assembly,
            };
            if resource.assembly != expected_assembly || metadata.assembly != expected_assembly {
                return Err(DgwError::InvalidResource(format!(
                    "gene annotation assembly mismatch: project {}, resource {}, index {}",
                    bundle.assembly, resource.assembly, metadata.assembly
                )));
            }
            if resource.contig_style != metadata.contig_style {
                return Err(DgwError::InvalidResource(format!(
                    "gene annotation contig style '{}' does not match its index style '{}'",
                    resource.contig_style, metadata.contig_style
                )));
            }
            if let Some(fingerprint) = &resource.fingerprint {
                if fingerprint.sha256 != metadata.source_sha256
                    || fingerprint.size != metadata.source_size
                {
                    return Err(DgwError::InvalidResource(
                        "gene annotation GTF fingerprint does not match its SQLite index".into(),
                    ));
                }
            }
        }
    }
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn fixture() -> NamedTempFile {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, "##fileformat=VCFv4.2").unwrap();
        writeln!(
            file,
            "##INFO=<ID=ANN,Number=.,Type=String,Description=\"Annotation\">"
        )
        .unwrap();
        writeln!(
            file,
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDEMO"
        )
        .unwrap();
        writeln!(
            file,
            "1\t100\t.\tA\tT\t.\tPASS\tANN=T|missense_variant\tGT\t0|1"
        )
        .unwrap();
        file
    }

    #[test]
    fn inspects_and_extracts_selected_sample() {
        let file = fixture();
        let inspection = inspect_vcf(file.path(), "b37").unwrap();
        assert_eq!(inspection.samples, vec!["DEMO"]);
        assert_eq!(inspection.record_count, 1);
        assert!(inspection.biallelic && inspection.sorted && inspection.has_ann);
        let (_, variants, warnings) = extract_selected_sample(file.path(), "b37", "DEMO").unwrap();
        assert_eq!(variants.len(), 1);
        assert!(warnings.is_empty());
        assert!(!variants[0].haplotype1_alt);
        assert!(variants[0].haplotype2_alt);
        assert!(variants[0].info.is_empty());
    }

    #[test]
    fn accepts_unannotated_input_and_ignores_imported_info() {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, "##fileformat=VCFv4.2").unwrap();
        writeln!(
            file,
            "##INFO=<ID=CLNSIG,Number=.,Type=String,Description=\"Imported classification\">"
        )
        .unwrap();
        writeln!(
            file,
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDEMO"
        )
        .unwrap();
        writeln!(
            file,
            "1\t100\trsTest\tA\tT\t42\tPASS\tCLNSIG=Pathogenic\tGT\t0/1"
        )
        .unwrap();

        let inspection = inspect_vcf(file.path(), "b37").unwrap();
        assert!(!inspection.has_ann);

        let (_, variants, warnings) = extract_selected_sample(file.path(), "b37", "DEMO").unwrap();
        assert!(warnings.is_empty());
        assert_eq!(variants.len(), 1);
        assert_eq!(variants[0].id.as_deref(), Some("rsTest"));
        assert_eq!(variants[0].quality.as_deref(), Some("42"));
        assert!(variants[0].unphased_alt);
        assert!(variants[0].info.is_empty());
    }

    #[test]
    fn imports_only_strict_pass_records() {
        let mut file = fixture();
        writeln!(file, "1\t101\t.\tA\tC\t.\tLowQual\t.\tGT\t0/1").unwrap();
        writeln!(file, "1\t102\t.\tA\tG\t.\t.\t.\tGT\t0/1").unwrap();

        let inspection = inspect_vcf(file.path(), "b37").unwrap();
        assert_eq!(inspection.record_count, 3);
        assert_eq!(inspection.pass_record_count, 1);
        assert_eq!(inspection.non_pass_record_count, 2);
        assert_eq!(inspection.supported_record_count, 1);

        let (_, variants, warnings) = extract_selected_sample(file.path(), "b37", "DEMO").unwrap();
        assert_eq!(variants.len(), 1);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("excluded 2 non-PASS"));
        assert!(warnings[0].contains("FILTER=LowQual"));
        assert!(warnings[0].contains("FILTER=."));
        assert!(warnings[0].contains("exactly PASS"));
    }

    #[test]
    fn accepts_unsorted_input_for_project_normalization() {
        let mut file = fixture();
        writeln!(file, "1\t99\t.\tA\tC\t.\tPASS\t.\tGT\t0/1").unwrap();

        let inspection = inspect_vcf(file.path(), "b37").unwrap();
        assert!(!inspection.sorted);
        let (_, variants, warnings) = extract_selected_sample(file.path(), "b37", "DEMO").unwrap();
        assert!(warnings.is_empty());
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].key.position, 100);
        assert_eq!(variants[1].key.position, 99);
    }

    #[test]
    fn preserves_unphased_heterozygous_calls() {
        let heterozygous = parse_gt(&["GT".into()], &["0/1".into()], 1).unwrap();
        assert_eq!(project_alt(heterozygous, 1), (false, false, true, Some(2)));
        let homozygous = parse_gt(&["GT".into()], &["1/1".into()], 1).unwrap();
        assert_eq!(project_alt(homozygous, 1), (true, true, false, None));
    }

    #[test]
    fn skips_non_small_variant_records_but_keeps_supported_snvs() {
        let mut file = fixture();
        writeln!(file, "1\t101\t.\tA\tCN0\t.\tPASS\tANN=.\tCN\t0").unwrap();
        writeln!(file, "1\t102\t.\tA\t<DEL>\t.\tPASS\tANN=.\tGT\t0|1").unwrap();
        writeln!(file, "1\t103\t.\tAC\tGT\t.\tPASS\tANN=.\tGT\t0|1").unwrap();
        writeln!(
            file,
            "1\t104\t.\tA\t{}\t.\tPASS\tANN=.\tGT\t0|1",
            "A".repeat(51)
        )
        .unwrap();

        let inspection = inspect_vcf(file.path(), "b37").unwrap();
        assert_eq!(inspection.record_count, 5);
        assert_eq!(inspection.supported_record_count, 1);
        assert_eq!(inspection.skipped_unsupported_record_count, 4);
        assert!(inspection.biallelic);

        let (_, variants, warnings) = extract_selected_sample(file.path(), "b37", "DEMO").unwrap();
        assert_eq!(variants.len(), 1);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("Skipped 4 unsupported"));
        assert!(warnings[0].contains("A>CN0"));
    }

    #[test]
    fn decomposes_phased_multiallelic_input_into_exact_alts() {
        let mut file = fixture();
        writeln!(file, "1\t101\t.\tA\tC,G\t.\tPASS\tANN=.\tGT\t1|2").unwrap();
        let inspection = inspect_vcf(file.path(), "b37").unwrap();
        assert!(!inspection.biallelic);
        assert_eq!(inspection.supported_record_count, 2);

        let (_, variants, warnings) = extract_selected_sample(file.path(), "b37", "DEMO").unwrap();
        assert!(warnings.is_empty());
        assert_eq!(variants.len(), 3);
        let c = variants
            .iter()
            .find(|variant| variant.key.position == 101 && variant.key.alternate == "C")
            .unwrap();
        let g = variants
            .iter()
            .find(|variant| variant.key.position == 101 && variant.key.alternate == "G")
            .unwrap();
        assert!(c.haplotype1_alt && !c.haplotype2_alt && !c.unphased_alt);
        assert!(!g.haplotype1_alt && g.haplotype2_alt && !g.unphased_alt);
        assert_eq!(c.sample_values, vec!["1|0"]);
        assert_eq!(g.sample_values, vec!["0|1"]);
    }

    #[test]
    fn preserves_both_alleles_of_unphased_one_two_genotype_without_inventing_phase() {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, "##fileformat=VCFv4.2").unwrap();
        writeln!(
            file,
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDEMO"
        )
        .unwrap();
        writeln!(file, "1\t100\t.\tA\tC,G\t.\tPASS\t.\tGT\t1/2").unwrap();

        let (_, variants, warnings) = extract_selected_sample(file.path(), "b37", "DEMO").unwrap();
        assert!(warnings.is_empty());
        assert_eq!(variants.len(), 2);
        let c = variants
            .iter()
            .find(|variant| variant.key.alternate == "C")
            .unwrap();
        let g = variants
            .iter()
            .find(|variant| variant.key.alternate == "G")
            .unwrap();
        assert!(c.unphased_alt && g.unphased_alt);
        assert_eq!(c.unphased_slot, Some(1));
        assert_eq!(g.unphased_slot, Some(2));
        assert_eq!(c.sample_values, vec!["1/0"]);
        assert_eq!(g.sample_values, vec!["0/1"]);
    }

    #[test]
    fn translates_common_contig_styles_without_changing_coordinates() {
        assert_eq!(translate_contig_style("1", CONTIG_STYLE_CHR), "chr1");
        assert_eq!(translate_contig_style("chr7", CONTIG_STYLE_NO_CHR), "7");
        assert_eq!(translate_contig_style("MT", CONTIG_STYLE_CHR), "chrM");
        assert_eq!(translate_contig_style("chrM", CONTIG_STYLE_NO_CHR), "MT");
    }

    #[test]
    fn resolves_only_aliases_present_in_the_reference() {
        let references = BTreeSet::from(["chr1".to_owned(), "chrM".to_owned()]);
        assert_eq!(resolve_reference_contig("1", &references).unwrap(), "chr1");
        assert_eq!(resolve_reference_contig("MT", &references).unwrap(), "chrM");
        assert!(resolve_reference_contig("2", &references).is_err());
    }
}
