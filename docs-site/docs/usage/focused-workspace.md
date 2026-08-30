# Focused Track Workspace

DGW centers the interface on the biological question currently being edited. There is no whole-genome track canvas and no read pileup.

## Navigate

The left navigator groups source alleles by contig. Expand a chromosome to see only its occupied genomic bins. A broad bin unfolds into narrower occupied bins; choosing a leaf of at most 50 kb loads that bounded region into the tracks. Alleles from the focused interval appear nested beneath the active leaf and can be opened directly. The tree queries compact counts and bins rather than loading the complete VCF into the interface. You can also enter an exact b37 contig/start/end interval. Typical edit work uses tens to hundreds of bases.

In the track deck, use **Ctrl/Command + wheel** to zoom around the pointer and **Shift + wheel** (or a horizontal trackpad gesture) to pan. The **+**, **−**, and arrow controls provide the same operations, while the navigator beneath the tracks scrolls across the contig. Press **0** or choose **Fit allele** to return to an 81-base window around the selected allele. At close range, one visible lane division represents one reference base. **Height −/+** changes track height without changing the genomic scale.

Choose **Select visible** to select VCF allele positions in the displayed interval. Choose **Select all in track** or press **Ctrl/Command+A** to select every active VCF allele across every chromosome on the selected track. The counter reports both the global selection and how many of those positions are currently visible. Neither action selects every reference base: DGW v0.1 can edit only positions represented by the input VCF. **Clear** removes the multi-selection. A normal lollipop click returns to one selected allele and opens its editor.

Use **Control-click** on a lollipop to add it to or remove it from an arbitrary multi-selection. DGW also accepts **Command-click** when that modifier reaches the application. When macOS hosts DGW inside a Linux virtual machine, use Control-click because the guest identifies itself as Linux and the virtualization software may reserve the Command key.

For mouse-only DAW-style selection, drag across empty space in the active track lane. A cyan marquee follows the pointer and selects every visible lollipop whose coordinate falls inside it. Dragging a new marquee replaces the previous selection; Control/Command-drag adds the enclosed lollipops. A marquee containing no lollipops clears the selection unless the additive modifier is held.

## Read the sequence rows

- **Track lane** shows the selected complete genome scenario and its persistent edit blocks over the current coordinates.
- **Selected change** shows the reference allele beside the allele produced by the selected edit block. It identifies an SNV, insertion, deletion, or substitution and shows the imported or newly calculated consequence when one is available.
- **REF** is fetched from the registered BGZF hs37d5 reference through its FAI/GZI indexes.
- **Chromosome copy A** applies the selected track's active first-haplotype calls and edits when phase is known.
- **Chromosome copy B** applies the corresponding second-haplotype calls and edits.

Reference alleles and variant alleles use distinct highlights in all three rows; the selected change also receives an outline. Insertions and deletions change the displayed genome-copy length while all edit operations remain anchored to reference coordinates.

One genome track always contains both homologous chromosome copies. A and B are working labels for the first and second phased VCF haplotypes; neither label means maternal or paternal unless explicit parental-origin information is imported. Chromosome-copy placement controls sequence reconstruction, not joint interpretation. Several nearby phased variants can appear together on chromosome copy A or B, but v0.1 still sends one variant at a time to SnpEff and performs one exact-allele lookup at a time in dbNSFP, ClinVar, and COSMIC. It does not predict their combined transcript or protein effect.

When two genome tracks are compared, they share the same reference coordinates. This lets you see what a device changed without implying that the two copies inside a track are separate experimental alternatives.

## Export the focused region as FASTA

Choose **File → Export FASTA…**. Its scope is **Focused region**, analogous to a DAW export between markers: DGW saves exactly the visible reference interval, not a whole chromosome or genome. DGW writes three FASTA records: the registered reference interval, chromosome copy A of the selected track, and chromosome copy B. Every header records the assembly, reference coordinates, track identity, chromosome-copy label, unknown parental origin, and phase status.

The copy sequences are consensus reconstructions from the registered reference FASTA plus the selected sample's effective VCF alleles and active DGW edits. They are not read-derived assemblies, and a position missing from the VCF is not proof that the individual was confidently homozygous reference there.

DGW never invents phase during export. An unphased heterozygous allele is masked with `N` across its REF span on both copy records. Its exact assembly, coordinate, REF, ALT, and track ID are written to a companion `*.unphased.tsv` file. For an unphased indel, the mask retains the reference-span length; consult the sidecar because FASTA alone cannot represent both possible sequence lengths without choosing a copy.

The focused export is limited to 50 kb. If an allele crosses the requested boundary, DGW asks you to expand the focus so the complete allele is included.

## Inspect live allele evidence

Selecting an observed or edited allele automatically starts the active exact-allele Evidence devices. DGW does not show or use a frozen input `ANN`; annotated and unannotated inputs follow the same path. Stable cached results appear first, and unavailable optional resources remain clearly unavailable rather than becoming an empty or benign result.
