//! Prepare a NEW, gene-restricted public-data project for the MCP device pilot.
use dgw_core::{search_gene_index, CreateProjectRequest, Project, ResourceBundle};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, process::Command};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 5 {
        return Err("usage: create_gene_pilot VCF SAMPLE BUNDLE_JSON GENE NEW_OUTPUT_DIR".into());
    }
    let source = PathBuf::from(&args[0]).canonicalize()?;
    let bundle: ResourceBundle = serde_json::from_slice(&fs::read(&args[2])?)?;
    let resource = bundle
        .gene_annotation
        .as_ref()
        .ok_or("gene index required")?;
    let gene = search_gene_index(&resource.index_path, &args[3], 100)?
        .into_iter()
        .find(|g| g.symbol == args[3] || g.gene_id == args[3])
        .ok_or("exact gene not found")?;
    let output = PathBuf::from(&args[4]);
    fs::create_dir(&output)?;
    let output = output.canonicalize()?;
    let region = format!("{}:{}-{}", gene.contig, gene.start, gene.end);
    let extracted = output.join("input.vcf");
    let result = Command::new(&bundle.bcftools_path)
        .args(["view", "-r", &region, "-Ov", "-o"])
        .arg(&extracted)
        .arg(&source)
        .output()?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).into_owned().into());
    }
    let project = Project::create(CreateProjectRequest {
        project_path: output.join("pilot.dgw"),
        name: format!("{} convergence pilot", gene.symbol),
        source_vcf_path: extracted,
        selected_sample: args[1].clone(),
        resource_bundle: bundle,
    })?;
    let metadata = serde_json::json!({
        "gene": gene, "originalInput": source,
        "originalSha256": format!("{:x}", Sha256::digest(fs::read(&source)?)),
        "manifest": project.manifest(), "tracks": project.list_tracks()?,
        "randomizerSeeds": [1,2,3,4,5,6,7,8,9,10], "morphSeed": 20260912,
        "morphAmounts": [0,25,50,75,100]
    });
    fs::write(
        output.join("input-manifest.json"),
        serde_json::to_vec_pretty(&metadata)?,
    )?;
    println!("{}", output.display());
    Ok(())
}
