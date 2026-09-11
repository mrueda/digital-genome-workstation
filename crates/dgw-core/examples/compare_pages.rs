//! Read-only comparison timing on a disposable copy of an existing project.
use dgw_core::Project;
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: compare_pages PROJECT_COPY")?;
    let project = Project::open(path)?;
    for track in project.list_tracks()? {
        for offset in [0, 10_000] {
            let start = Instant::now();
            let page = project.track_comparison_page(&track.id, offset, 200)?;
            println!(
                "track={} offset={} loci={} rows={} changed_on_page={} elapsed_ms={:.1}",
                track.name,
                offset,
                page.total_loci,
                page.rows.len(),
                page.rows.iter().filter(|r| r.changed).count(),
                start.elapsed().as_secs_f64() * 1000.0
            );
        }
        let start = Instant::now();
        let index = project.build_track_comparison_index(&track.id)?;
        println!(
            "track={} index_ms={:.1} changed={} total={}",
            track.name,
            start.elapsed().as_secs_f64() * 1000.0,
            index.changed_keys.len(),
            index.total_loci
        );
        for _ in 0..3 {
            let start = Instant::now();
            let page = project.changed_comparison_page(&index, 0, 200)?;
            println!(
                "track={} changed_page_ms={:.1} rows={}",
                track.name,
                start.elapsed().as_secs_f64() * 1000.0,
                page.rows.len()
            );
        }
    }
    Ok(())
}
