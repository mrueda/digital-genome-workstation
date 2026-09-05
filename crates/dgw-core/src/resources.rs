//! Resolve a portable resource descriptor without changing its scientific identity.
use crate::{DgwError, ResourceBundle, Result};
use std::path::{Component, Path, PathBuf};

pub fn resolve_bundle_paths(mut bundle: ResourceBundle, root: &Path) -> Result<ResourceBundle> {
    fn resolve(path: &mut PathBuf, root: &Path) -> Result<()> {
        if path.as_os_str().is_empty() || path.is_absolute() {
            return Ok(());
        }
        if path
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err(DgwError::InvalidResource(
                "resource paths cannot escape the bundle directory".into(),
            ));
        }
        *path = root.join(&*path);
        Ok(())
    }
    for path in [
        &mut bundle.reference_path,
        &mut bundle.reference_fai_path,
        &mut bundle.bcftools_path,
        &mut bundle.bgzip_path,
        &mut bundle.tabix_path,
    ] {
        resolve(path, root)?;
    }
    if let Some(path) = &mut bundle.reference_gzi_path {
        resolve(path, root)?;
    }
    for resource in [&mut bundle.clinvar, &mut bundle.cosmic] {
        resolve(&mut resource.path, root)?;
        resolve(&mut resource.index_path, root)?;
        if let Some(fp) = &mut resource.fingerprint {
            resolve(&mut fp.path, root)?;
        }
    }
    if let Some(resource) = &mut bundle.gene_annotation {
        resolve(&mut resource.path, root)?;
        resolve(&mut resource.index_path, root)?;
        if let Some(fp) = &mut resource.fingerprint {
            resolve(&mut fp.path, root)?;
        }
    }
    if let Some(resource) = &mut bundle.consequence_annotation {
        resolve(&mut resource.path, root)?;
        if let Some(fp) = &mut resource.fingerprint {
            resolve(&mut fp.path, root)?;
        }
    }
    Ok(bundle)
}
