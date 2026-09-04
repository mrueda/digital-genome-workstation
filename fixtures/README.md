# Test fixtures

## `dgw-cluster.synthetic.vcf`

The default workstation demonstration. One fictional sample (`DGW_DEMO`) has ten synthetic SNVs: seven across 55 bases around the BRAF V600E coordinate on chromosome 7 and three near TP53 on chromosome 17. The dense chromosome 7 layout makes the imported VCF alleles, lollipop selection, horizontal zoom, track duplication, and mutation blocks visible together, while chromosome 17 demonstrates explicit chromosome boundaries and navigation. All REF bases were checked against hs37d5. The genotypes contain no participant data.

This is the GRCh37 fixture opened when the onboarding screen's **GRCh37** reference profile is selected. It is bundled with desktop builds.

## `dgw-cluster.grch38.synthetic.vcf`

The matching GRCh38 workstation demonstration. It keeps the same fictional `DGW_DEMO` sample and two-neighborhood structure, with seven SNVs around BRAF V600E on `chr7` and three near TP53 on `chr17`. Its coordinates and REF alleles were checked against the configured hg38 FASTA. It contains no participant data.

This fixture is opened when the onboarding screen's **GRCh38** reference profile is selected and is bundled with desktop builds. The two example files are independent assembly-specific inputs; DGW does not lift one into the other.

## `braf-v600e.synthetic.vcf`

One fictional sample (`DGW_DEMO`) with an unphased BRAF V600E genotype. The file is generated test data and contains no participant data.
It remains the focused real-resource smoke-test fixture because its exact Variant Consequences, dbNSFP, ClinVar, and COSMIC behavior is easy to verify.

## `multiallelic.synthetic.vcf`

A fictional one-sample fixture for the multiallelic importer. `DGW_MULTI` has one unphased `1/2` and one phased `1|2` SNV record. Each row projects to two independently selectable exact alleles, while the genotype retains either copy-unknown `/` slots or explicit chromosome-copy placement. REF bases were checked against hs37d5. The file contains no participant data.

## `import-normalization.synthetic.vcf`

A fictional one-sample deletion written as the valid but non-minimal `1:970549 TGG>TG`. During import, DGW normalizes its private projection to `1:970549 TG>T` against hs37d5 while leaving this source fixture unchanged. It is the regression fixture for automatic import normalization and contains no participant data.

## `1000G-HG00096.public.vcf.gz`

A selected-sample subset extracted from the 2,504-sample public 1000 Genomes test cohort used by the CINECA/Beacon development stack. It contains the 35 non-reference, phased records for sample `HG00096`, including annotations already present in the source cohort; DGW accepts but ignores those INFO annotations. The adjacent `.csi` file is its index.

The extraction command was:

```bash
bcftools view -s HG00096 -c 1 -Oz \
  -o fixtures/1000G-HG00096.public.vcf.gz \
  test_1000G.norm.ann.dbnsfp.clinvar.cosmic.vcf.gz
tabix -f -C -p vcf fixtures/1000G-HG00096.public.vcf.gz
```

This fixture is public human variation data, not synthetic data. Do not replace it with private or identifiable project samples.
