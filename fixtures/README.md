# Test fixtures

## `dgw-cluster.synthetic.vcf`

The default workstation demonstration. One fictional sample (`DGW_DEMO`) has ten synthetic SNVs: seven across 55 bases around the BRAF V600E coordinate on chromosome 7 and three near TP53 on chromosome 17. The dense chromosome 7 layout makes the imported VCF alleles, lollipop selection, horizontal zoom, track duplication, and mutation blocks visible together, while chromosome 17 demonstrates explicit chromosome boundaries and navigation. All REF bases were checked against hs37d5. The genotypes contain no participant data.

This is the GRCh37 fixture opened when the onboarding screen's **GRCh37** reference profile is selected. It is bundled with desktop builds.

## `dgw-cluster.grch38.synthetic.vcf`

The matching GRCh38 workstation demonstration. It keeps the same fictional `DGW_DEMO` sample and two-neighborhood structure, with seven SNVs around BRAF V600E on `chr7` and three near TP53 on `chr17`. Its coordinates and REF alleles were checked against the configured hg38 FASTA. It contains no participant data.

This fixture is opened when the onboarding screen's **GRCh38** reference profile is selected and is bundled with desktop builds. The two example files are independent assembly-specific inputs; DGW does not lift one into the other.

## `braf-v600e.synthetic.vcf`

One fictional sample (`DGW_DEMO`) with an unphased BRAF V600E genotype. The file is generated test data and contains no participant data.
It remains the focused real-resource smoke-test fixture because its exact Variant Consequences, ClinVar, and COSMIC behavior is easy to verify.

## `multiallelic.synthetic.vcf`

A fictional one-sample fixture for the multiallelic importer. `DGW_MULTI` has one unphased `1/2` and one phased `1|2` SNV record. Each row projects to two independently selectable exact alleles, while the genotype retains either copy-unknown `/` slots or explicit chromosome-copy placement. REF bases were checked against hs37d5. The file contains no participant data.

## `import-normalization.synthetic.vcf`

A fictional one-sample deletion written as the valid but non-minimal `1:970549 TGG>TG`. During import, DGW normalizes its private projection to `1:970549 TG>T` against hs37d5 while leaving this source fixture unchanged. It is the regression fixture for automatic import normalization and contains no participant data.

## `1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz`

A public 1000 Genomes whole-exome example for sample `HG00103`, downloaded as read accession `SRR1596639` and called with GATK HaplotypeCaller/GenotypeGVCFs 4.6.2.0 against b37 Broad exome intervals. It spans every autosome and chromosome X. The selected sample has 19,578 `FILTER=PASS` non-reference source records: 19,003 SNV ALTs, 604 indel ALTs, and 29 multiallelic records. DGW decomposes the multiallelic rows and imports 19,598 exact alleles. The genotypes deliberately exercise both phased and unphased input.

The fixture keeps only `GT`; source INFO and other FORMAT fields were removed because DGW evaluates exact alleles from its configured resources. Local command paths in the GATK and bcftools header records were also removed. The adjacent `.csi` is its index. Extraction was equivalent to:

```bash
bcftools view -i 'FILTER="PASS" && GT="alt"' -Ou SRR1596639.hc.QC.vcf.gz \
  | bcftools annotate -x 'INFO,^FORMAT/GT' -Oz \
      -o fixtures/1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz
tabix -f -C -p vcf fixtures/1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz
```

The local source had SHA-256 `3d2ac528d4d18d762647e46c80437650b399460aac4c067170ff2aef3ad53d47`. The sanitized fixture VCF has SHA-256 `4a70aec74eca0b21265e2be1b330356bc17337d8d73be78b3095fa4f2d0ad97a`; its CSI has SHA-256 `b888da12cbbd358b9db9a707a11008077c20525c90610db448bf37e9343b7f75`.

**File → Open Example Project → HG00103 exome — GRCh37** creates a protected source track and a clean editable working track focused on `LDLR`, which has five called SNVs. No optimizer result is applied in advance: this example is the realistic multi-chromosome workload rather than a scripted biological conclusion.
