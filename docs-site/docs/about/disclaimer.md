# Disclaimer

Digital Genome Workstation is research software. It is not a medical device and is not intended for diagnosis, treatment selection, clinical reporting, or other patient-care decisions.

Predicted consequences depend on the selected transcript models, tool versions, configurations, reference assembly, and database releases. ClinVar, COSMIC, and dbNSFP records require domain interpretation; a database match is not itself a clinical classification, and no exact match is not evidence of benignity.

Several changes may appear together on one genome track, but DGW currently evaluates them one allele at a time. Their combined transcript, protein, health, or disease consequence is not known from those independent annotations.

The experimental Genome Optimizer uses only exact alleles from the immutable source VCF. Alternate-allele burden is a count; predicted-impact burden is an additive sum of imported impact, recognized ClinVar classification, and exact-source-membership signals. Neither score models interactions, phase-dependent compound effects, penetrance, environment, or the rest of the genome.

**Minimize** and **Maximize** refer only to the selected technical score. Maximize can only reintroduce a missing original-source allele; it is not disease maximization. No result may be described as perfect, healthy, safe, disease-free, or biologically optimal.

Device settings and the complete optimizer plan are not yet persisted. Generated edits remain in immutable state ancestry, but the project package alone cannot currently reproduce the displayed optimizer run.

The software reconstructs reference sequence plus calls represented in the imported VCF. It has no read coverage or callable-region evidence and must not represent omitted loci as experimentally confirmed reference genotypes.
