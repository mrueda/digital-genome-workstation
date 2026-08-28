# Test fixtures

## `dgw-cluster.synthetic.vcf`

The default workstation demonstration. One fictional sample (`DGW_DEMO`) has seven synthetic SNVs across 55 bases around the BRAF V600E coordinate. This deliberately dense layout makes the imported VCF alleles, lollipop selection, horizontal zoom, track duplication, and mutation blocks visible together. All REF bases were checked against hs37d5. The genotypes contain no participant data.

This is the fixture opened by the onboarding screen's **Load example** button and bundled with desktop builds.

## `braf-v600e.synthetic.vcf`

One fictional sample (`DGW_DEMO`) with an unphased BRAF V600E genotype. The file is generated test data and contains no participant data.
It remains the focused real-resource smoke-test fixture because its exact SnpEff, dbNSFP, ClinVar, and COSMIC behavior is easy to verify.

## `1000G-HG00096.public.vcf.gz`

A selected-sample subset extracted from the 2,504-sample public 1000 Genomes test cohort used by the CINECA/Beacon development stack. It contains the 35 non-reference, phased records for sample `HG00096`, including the annotations already present in the source cohort. The adjacent `.csi` file is its index.

The extraction command was:

```bash
bcftools view -s HG00096 -c 1 -Oz \
  -o fixtures/1000G-HG00096.public.vcf.gz \
  test_1000G.norm.ann.dbnsfp.clinvar.cosmic.vcf.gz
tabix -f -C -p vcf fixtures/1000G-HG00096.public.vcf.gz
```

This fixture is public human variation data, not synthetic data. Do not replace it with private or identifiable project samples.
