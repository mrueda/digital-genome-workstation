export interface ContextHelpTopic {
  title: string;
  purpose: string;
  effect: string;
  limitation?: string;
}

export const DEFAULT_CONTEXT_HELP_KEY = "workspace";

export const CONTEXT_HELP_TOPICS: Record<string, ContextHelpTopic> = {
  workspace: {
    title: "Genome workspace",
    purpose: "Move the pointer over a DGW control, or focus it with the keyboard, to learn what it does.",
    effect: "Context Help follows the interface without changing the project.",
    limitation: "Pin an explanation when you want it to remain visible while working elsewhere."
  },
  transport: {
    title: "Genome review",
    purpose: "Step through or automatically review variants or active edits in the current scope.",
    effect: "The focused allele and its active Evidence results update as review advances.",
    limitation: "Review does not create edits, run bulk analysis, or consolidate a track."
  },
  "transport-scope": {
    title: "Review target",
    purpose: "Choose whether review visits imported variant loci or active edit loci.",
    effect: "The current selection, active gene, or visible interval determines the review scope.",
    limitation: "Changing the target does not change the allele selection itself."
  },
  "transport-play": {
    title: "Automatic review",
    purpose: "Visit each target in order and refresh the active Evidence devices for its exact allele.",
    effect: "The Evidence panel opens, the current target is centred, and progress appears in the Transport readout.",
    limitation: "No mutation is generated or applied."
  },
  "transport-step": {
    title: "Step review",
    purpose: "Move to the previous or next review target without starting automatic review.",
    effect: "DGW centres and selects the target allele.",
    limitation: "Manual stepping navigates only; it does not run a bulk Track Profile."
  },
  "transport-stop": {
    title: "Stop review",
    purpose: "End automatic review and return to the interval and allele where it began.",
    effect: "The review cursor is cleared and the starting view is restored.",
    limitation: "Pause, rather than Stop, keeps the current reviewed allele in place."
  },
  "transport-loop": {
    title: "Loop review",
    purpose: "Repeat the current review scope after its final target.",
    effect: "The same frozen set of variants or edits is reviewed again.",
    limitation: "Edits made during review are not silently added to the frozen pass."
  },
  "coordinate-jump": {
    title: "Go to coordinates",
    purpose: "Open a 1-based chromosome interval directly.",
    effect: "The focused view moves to the entered coordinates.",
    limitation: "DGW changes contig naming safely but does not lift coordinates between assemblies."
  },
  "chromosome-overview": {
    title: "Chromosome overview",
    purpose: "See source-allele density across the chromosome and control the visible Track interval.",
    effect: "Click to centre, drag the highlighted window to pan, or drag its edges and use the wheel to zoom.",
    limitation: "The density rail summarizes imported VCF alleles; it is not base-level read coverage."
  },
  "source-variants": {
    title: "Source Variants",
    purpose: "Browse the immutable alleles imported from the selected VCF sample.",
    effect: "Choosing an allele centres the working view and opens its exact-allele context.",
    limitation: "The browser is navigation; edits belong to candidate Genome Tracks."
  },
  "gene-search": {
    title: "Gene navigation",
    purpose: "Find an Ensembl gene by symbol or stable identifier and focus its genomic interval.",
    effect: "You can then select every imported allele that falls within the gene coordinates.",
    limitation: "Gene lookup uses the project assembly and configured GTF; it does not search transcripts independently."
  },
  tracks: {
    title: "Genome Tracks",
    purpose: "Compare independent, editable versions of the selected genome while preserving the source track.",
    effect: "Variant lollipops and persistent mutation blocks remain visible until explicitly bypassed or consolidated.",
    limitation: "Tracks compare genome states; they are not sequencing-read tracks or mixed biological samples."
  },
  "device-rack": {
    title: "Device Rack",
    purpose: "Apply ordered Evidence, Edit, Analyze, and Visualization devices to the selected track.",
    effect: "Reset restores device controls without changing applied edits. Only database Evidence devices have Bypass: it excludes that evidence without changing the genome. Use Undo/Redo for editing actions.",
    limitation: "An applied device is not necessarily included in every scoring objective."
  },
  "genome-optimizer": {
    title: "Genome Optimizer",
    purpose: "Rank eligible allele changes against an explicit additive proxy objective.",
    effect: "Saturation evaluates three non-reference SNV bases per selected position and applies only strict improvements, up to Maximum changes.",
    limitation: "Consequence Predictor uses four coarse impact classes; ties keep the current ALT, and the result is not disease probability."
  },
  "track-monitor": {
    title: "Track Monitor",
    purpose: "Summarize the additive allele-level signal for all active mutations on the selected track.",
    effect: "It updates automatically for small changes and through a background Track Profile for bulk layers.",
    limitation: "The meter is not disease probability and does not model interactions or penetrance."
  },
  "evidence-panel": {
    title: "Evidence",
    purpose: "Inspect external-resource results for the one exact allele currently selected.",
    effect: "Active Evidence devices run automatically and can be refreshed explicitly.",
    limitation: "Evidence is allele-specific; nearby changes are not interpreted as one combined consequence."
  }
};
