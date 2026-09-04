use dgw_core::build_gene_index;
use std::env;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = env::args().collect();
    if arguments.len() != 7 {
        return Err(format!(
            "usage: {} <genes.gtf[.gz]> <genes.sqlite> <assembly> <release> <contig-style> <source-url>",
            arguments.first().map(String::as_str).unwrap_or("build_gene_index")
        )
        .into());
    }
    let metadata = build_gene_index(
        &PathBuf::from(&arguments[1]),
        &PathBuf::from(&arguments[2]),
        &arguments[3],
        &arguments[4],
        &arguments[5],
        &arguments[6],
    )?;
    println!("{}", serde_json::to_string_pretty(&metadata)?);
    Ok(())
}
