use crate::error::{DgwError, Result};
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

fn contig_rank(contig: &str) -> (u16, String) {
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
            let key = parse_key(&fields, assembly)?;
            if key.alternate.contains(',') {
                biallelic = false;
            } else if is_supported_small_variant(&key) {
                supported_record_count += 1;
            } else {
                skipped_unsupported_record_count += 1;
            }
            let current_sort_key = (contig_rank(&key.contig), key.position);
            if previous_sort_key
                .as_ref()
                .is_some_and(|previous| previous > &current_sort_key)
            {
                sorted = false;
            }
            previous_sort_key = Some(current_sort_key);
            contigs.insert(key.contig.clone());
            if is_supported_small_variant(&key) {
                if first_variant.is_none() {
                    first_variant = Some(key.clone());
                }
                last_variant = Some(key);
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

    Ok(VcfInspection {
        path: path.to_path_buf(),
        file_format,
        samples,
        contigs: contigs.into_iter().collect(),
        has_ann,
        record_count,
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

fn parse_gt(format_keys: &[String], sample_values: &[String]) -> Result<(bool, bool, bool)> {
    let gt_index = format_keys
        .iter()
        .position(|key| key == "GT")
        .ok_or_else(|| DgwError::InvalidVcf("selected sample has no GT field".into()))?;
    let gt = sample_values
        .get(gt_index)
        .ok_or_else(|| DgwError::InvalidVcf("selected sample GT is missing".into()))?;
    if gt == "." || gt == "./." || gt == ".|." {
        return Ok((false, false, false));
    }
    let phased = gt.contains('|');
    let alleles: Vec<&str> = gt.split(['|', '/']).collect();
    if alleles.len() != 2 {
        return Err(DgwError::InvalidVcf(format!(
            "v1 requires diploid GT, found {gt}"
        )));
    }
    if alleles
        .iter()
        .any(|value| !matches!(*value, "0" | "1" | "."))
    {
        return Err(DgwError::InvalidVcf(format!(
            "biallelic GT expected, found {gt}"
        )));
    }
    if !phased && alleles[0] != alleles[1] {
        return Ok((false, false, true));
    }
    Ok((alleles[0] == "1", alleles[1] == "1", false))
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
    let mut previous_sort_key: Option<((u16, String), u64)> = None;
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
            let key = parse_key(&fields, assembly)?;
            if key.alternate.contains(',') {
                return Err(DgwError::InvalidVcf(format!(
                    "multiallelic record is not supported: {}",
                    key.display()
                )));
            }
            let current_sort_key = (contig_rank(&key.contig), key.position);
            if previous_sort_key
                .as_ref()
                .is_some_and(|previous| previous > &current_sort_key)
            {
                return Err(DgwError::InvalidVcf(format!(
                    "VCF is not sorted before {}",
                    key.display()
                )));
            }
            previous_sort_key = Some(current_sort_key);

            // Unsupported allele classes do not enter the selected-sample
            // projection. Skip them before parsing FORMAT because CNV/SV
            // callers may use fields that do not follow the small-variant GT
            // contract required by DGW.
            if !is_supported_small_variant(&key) {
                skipped_unsupported += 1;
                if skipped_examples.len() < 3 {
                    skipped_examples.push(key.display());
                }
                line.clear();
                continue;
            }

            let format_keys: Vec<String> = fields[8].split(':').map(str::to_owned).collect();
            let selected_index = sample_index.expect("#CHROM must precede records");
            let selected = fields.get(selected_index).ok_or_else(|| {
                DgwError::InvalidVcf(format!("sample column missing at {}", key.display()))
            })?;
            let sample_values: Vec<String> = selected.split(':').map(str::to_owned).collect();
            let (haplotype1_alt, haplotype2_alt, unphased_alt) =
                parse_gt(&format_keys, &sample_values)?;
            if !haplotype1_alt && !haplotype2_alt && !unphased_alt {
                line.clear();
                continue;
            }
            let variant = RootVariant {
                key,
                id: (fields[2] != ".").then(|| fields[2].to_owned()),
                quality: (fields[5] != ".").then(|| fields[5].to_owned()),
                filter: fields[6].to_owned(),
                // Imported INFO is provenance, not live DGW evidence. It may
                // describe only the source ALT and must never be reused after
                // an allele edit. The frozen selected-sample VCF remains the
                // lossless copy of the original record.
                info: BTreeMap::new(),
                format_keys,
                sample_values,
                haplotype1_alt,
                haplotype2_alt,
                unphased_alt,
                source_line: trimmed.to_owned(),
            };
            on_variant(&variant)?;
        }
        line.clear();
    }

    if sample_index.is_none() {
        return Err(DgwError::InvalidVcf("VCF has no #CHROM header".into()));
    }
    let warnings = if skipped_unsupported == 0 {
        Vec::new()
    } else {
        vec![format!(
            "Skipped {skipped_unsupported} unsupported source VCF record{} while projecting the selected sample (examples: {}). DGW v1 imports only biallelic, sequence-resolved SNVs and 1–49 bp indels.",
            if skipped_unsupported == 1 { "" } else { "s" },
            skipped_examples.join(", ")
        )]
    };
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
    if bundle.assembly != "b37" {
        return Err(DgwError::InvalidResource(
            "v1 currently requires assembly b37".into(),
        ));
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

    let mut warnings = Vec::new();
    let snpeff_ready = bundle.java_path.is_file()
        && bundle.snpeff_jar_path.is_file()
        && !bundle.snpeff_genome.trim().is_empty();
    if !snpeff_ready {
        warnings.push(
            "SnpEff resources are incomplete; its device will remain unavailable until configured"
                .into(),
        );
    } else if bundle.snpeff_genome != "hg19" {
        warnings.push(format!(
            "SnpEff genome '{}' is configured for a b37 project; verify that this database uses the same assembly",
            bundle.snpeff_genome
        ));
    }
    if bundle
        .snpeff_config_path
        .as_ref()
        .is_some_and(|path| !path.is_file())
    {
        warnings.push(
            "The configured SnpEff config file is missing; the SnpEff device will remain unavailable"
                .into(),
        );
    }
    for resource in [&bundle.dbnsfp, &bundle.clinvar, &bundle.cosmic] {
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
    fn preserves_unphased_heterozygous_calls() {
        assert_eq!(
            parse_gt(&["GT".into()], &["0/1".into()]).unwrap(),
            (false, false, true)
        );
        assert_eq!(
            parse_gt(&["GT".into()], &["1/1".into()]).unwrap(),
            (true, true, false)
        );
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
    fn still_rejects_multiallelic_input() {
        let mut file = fixture();
        writeln!(file, "1\t101\t.\tA\tC,G\t.\tPASS\tANN=.\tGT\t1|2").unwrap();
        let error = extract_selected_sample(file.path(), "b37", "DEMO").unwrap_err();
        assert!(error.to_string().contains("multiallelic record"));
    }
}
