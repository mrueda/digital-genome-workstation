use crate::{DgwError, Result};
use chrono::Utc;
use flate2::read::MultiGzDecoder;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

pub const GENE_INDEX_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneIndexMetadata {
    pub schema_version: u32,
    pub assembly: String,
    pub release: String,
    pub contig_style: String,
    pub source_url: String,
    pub source_sha256: String,
    pub source_size: u64,
    pub gene_count: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneLocus {
    pub gene_id: String,
    pub symbol: String,
    pub contig: String,
    pub start: u64,
    pub end: u64,
    pub strand: String,
    pub biotype: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneSearchHit {
    #[serde(flatten)]
    pub locus: GeneLocus,
    pub source_variant_count: u64,
}

pub fn build_gene_index(
    gtf_path: &Path,
    index_path: &Path,
    assembly: &str,
    release: &str,
    contig_style: &str,
    source_url: &str,
) -> Result<GeneIndexMetadata> {
    if !gtf_path.is_file() {
        return Err(DgwError::InvalidResource(format!(
            "gene GTF does not exist: {}",
            gtf_path.display()
        )));
    }
    if index_path.exists() {
        return Err(DgwError::InvalidResource(format!(
            "gene index already exists: {}",
            index_path.display()
        )));
    }

    let source_size = gtf_path.metadata()?.len();
    let source_sha256 = file_sha256(gtf_path)?;
    let file = File::open(gtf_path)?;
    let reader: Box<dyn BufRead> = if gtf_path.extension().is_some_and(|value| value == "gz") {
        Box::new(BufReader::new(MultiGzDecoder::new(file)))
    } else {
        Box::new(BufReader::new(file))
    };

    let mut connection = Connection::open(index_path)?;
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE metadata (
           singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
           payload TEXT NOT NULL
         );
         CREATE TABLE genes (
           gene_id TEXT NOT NULL,
           symbol TEXT NOT NULL,
           symbol_upper TEXT NOT NULL,
           gene_id_upper TEXT NOT NULL,
           contig TEXT NOT NULL,
           start INTEGER NOT NULL,
           end INTEGER NOT NULL,
           strand TEXT NOT NULL,
           biotype TEXT,
           PRIMARY KEY(gene_id, contig, start, end)
         );
         CREATE INDEX genes_symbol_idx ON genes(symbol_upper, gene_id_upper);
         CREATE INDEX genes_region_idx ON genes(contig, start, end);",
    )?;
    let transaction = connection.transaction()?;
    let mut insert = transaction.prepare(
        "INSERT INTO genes(
           gene_id, symbol, symbol_upper, gene_id_upper, contig, start, end, strand, biotype
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?;

    let mut gene_count = 0_u64;
    let mut declared_build = None;
    for line in reader.lines() {
        let line = line?;
        if let Some(value) = line.strip_prefix("#!genome-build ") {
            declared_build = Some(value.trim().to_owned());
            continue;
        }
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.splitn(9, '\t').collect();
        if fields.len() != 9 || fields[2] != "gene" {
            continue;
        }
        let attributes = parse_gtf_attributes(fields[8]);
        let gene_id = attributes.get("gene_id").ok_or_else(|| {
            DgwError::InvalidResource(format!("GTF gene row is missing gene_id: {line}"))
        })?;
        let symbol = attributes.get("gene_name").unwrap_or(gene_id);
        let start: u64 = fields[3].parse().map_err(|_| {
            DgwError::InvalidResource(format!("invalid GTF gene start in row: {line}"))
        })?;
        let end: u64 = fields[4].parse().map_err(|_| {
            DgwError::InvalidResource(format!("invalid GTF gene end in row: {line}"))
        })?;
        if start == 0 || end < start {
            return Err(DgwError::InvalidResource(format!(
                "invalid 1-based inclusive GTF gene interval in row: {line}"
            )));
        }
        let biotype = attributes
            .get("gene_biotype")
            .or_else(|| attributes.get("gene_type"));
        insert.execute(params![
            gene_id,
            symbol,
            symbol.to_uppercase(),
            gene_id.to_uppercase(),
            fields[0],
            start,
            end,
            fields[6],
            biotype,
        ])?;
        gene_count = gene_count.saturating_add(1);
    }
    drop(insert);

    if gene_count == 0 {
        return Err(DgwError::InvalidResource(
            "GTF contains no gene feature rows".into(),
        ));
    }
    if let Some(declared) = declared_build {
        if !declared.eq_ignore_ascii_case(assembly)
            && !declared
                .to_ascii_lowercase()
                .starts_with(&assembly.to_ascii_lowercase())
        {
            return Err(DgwError::InvalidResource(format!(
                "GTF declares genome build {declared}, not {assembly}"
            )));
        }
    }
    let metadata = GeneIndexMetadata {
        schema_version: GENE_INDEX_SCHEMA_VERSION,
        assembly: assembly.into(),
        release: release.into(),
        contig_style: contig_style.into(),
        source_url: source_url.into(),
        source_sha256,
        source_size,
        gene_count,
        created_at: Utc::now().to_rfc3339(),
    };
    transaction.execute(
        "INSERT INTO metadata(singleton, payload) VALUES (1, ?1)",
        [serde_json::to_string(&metadata)?],
    )?;
    transaction.commit()?;
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(metadata)
}

pub fn gene_index_metadata(index_path: &Path) -> Result<GeneIndexMetadata> {
    let connection = readonly_connection(index_path)?;
    let payload: String = connection.query_row(
        "SELECT payload FROM metadata WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    let metadata: GeneIndexMetadata = serde_json::from_str(&payload)?;
    if metadata.schema_version != GENE_INDEX_SCHEMA_VERSION {
        return Err(DgwError::InvalidResource(format!(
            "unsupported gene-index schema {}",
            metadata.schema_version
        )));
    }
    Ok(metadata)
}

pub fn search_gene_index(index_path: &Path, query: &str, limit: u32) -> Result<Vec<GeneLocus>> {
    let query = query.trim().to_uppercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let connection = readonly_connection(index_path)?;
    let prefix = format!("{}%", escape_like(&query));
    let contains = format!("%{}%", escape_like(&query));
    let mut statement = connection.prepare(
        "SELECT gene_id, symbol, contig, start, end, strand, biotype
           FROM genes
          WHERE symbol_upper LIKE ?2 ESCAPE '\\' OR gene_id_upper LIKE ?2 ESCAPE '\\'
             OR symbol_upper LIKE ?3 ESCAPE '\\' OR gene_id_upper LIKE ?3 ESCAPE '\\'
          ORDER BY CASE
            WHEN symbol_upper = ?1 OR gene_id_upper = ?1 THEN 0
            WHEN symbol_upper LIKE ?2 ESCAPE '\\' OR gene_id_upper LIKE ?2 ESCAPE '\\' THEN 1
            ELSE 2
          END, symbol_upper, gene_id_upper, contig, start
          LIMIT ?4",
    )?;
    let rows = statement.query_map(
        params![query, prefix, contains, limit.clamp(1, 100)],
        |row| {
            Ok(GeneLocus {
                gene_id: row.get(0)?,
                symbol: row.get(1)?,
                contig: row.get(2)?,
                start: row.get(3)?,
                end: row.get(4)?,
                strand: row.get(5)?,
                biotype: row.get(6)?,
            })
        },
    )?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn readonly_connection(path: &Path) -> Result<Connection> {
    if !path.is_file() {
        return Err(DgwError::InvalidResource(format!(
            "gene index does not exist: {}",
            path.display()
        )));
    }
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

fn parse_gtf_attributes(value: &str) -> BTreeMap<String, String> {
    value
        .split(';')
        .filter_map(|field| {
            let field = field.trim();
            let (key, value) = field.split_once(char::is_whitespace)?;
            Some((key.into(), value.trim().trim_matches('"').into()))
        })
        .collect()
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn builds_and_searches_a_gene_only_gtf_index() {
        let temporary = tempdir().unwrap();
        let gtf_path = temporary.path().join("genes.gtf.gz");
        let index_path = temporary.path().join("genes.sqlite");
        let file = File::create(&gtf_path).unwrap();
        let mut writer = GzEncoder::new(file, Compression::default());
        writeln!(writer, "#!genome-build GRCh37.p13").unwrap();
        writeln!(writer, "1\ttest\tgene\t100\t900\t.\t+\t.\tgene_id \"ENSG1\"; gene_name \"BRCA1\"; gene_biotype \"protein_coding\";").unwrap();
        writeln!(
            writer,
            "1\ttest\ttranscript\t100\t900\t.\t+\t.\tgene_id \"ENSG1\"; transcript_id \"ENST1\";"
        )
        .unwrap();
        writeln!(
            writer,
            "2\ttest\tgene\t50\t80\t.\t-\t.\tgene_id \"ENSG2\"; gene_biotype \"lncRNA\";"
        )
        .unwrap();
        writer.finish().unwrap();

        let metadata = build_gene_index(
            &gtf_path,
            &index_path,
            "GRCh37",
            "Ensembl test",
            "no_chr_prefix",
            "https://example.test/genes.gtf.gz",
        )
        .unwrap();
        assert_eq!(metadata.gene_count, 2);
        assert_eq!(gene_index_metadata(&index_path).unwrap(), metadata);
        let result = search_gene_index(&index_path, "brca", 10).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].gene_id, "ENSG1");
        assert_eq!(result[0].symbol, "BRCA1");
        assert_eq!(
            search_gene_index(&index_path, "ENSG2", 10).unwrap()[0].symbol,
            "ENSG2"
        );
    }
}
