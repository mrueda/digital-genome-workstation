import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './index.module.css';

const guideLinks = [
  {
    label: 'Start',
    title: 'Load one genome',
    text: 'Register a b37 resource stack, inspect an annotated VCF, and select one sample as the source track.',
    to: '/docs/usage/quickstart',
  },
  {
    label: 'Tracks',
    title: 'Build genome scenarios',
    text: 'Duplicate the source track, apply devices, keep edit blocks visible, and bypass or compare changes.',
    to: '/docs/usage/edit-and-compare',
  },
  {
    label: 'Interpret',
    title: 'Use analysis and evidence devices',
    text: 'Inspect SnpEff consequences and exact dbNSFP, ClinVar, and COSMIC matches, with resource versions recorded.',
    to: '/docs/usage/evaluate-alleles',
  },
  {
    label: 'Developers',
    title: 'Understand the engine',
    text: 'See how named tracks map to the immutable state DAG, project package, evaluation worker, and VCF contracts.',
    to: '/docs/technical-details/',
  },
];

export default function Home() {
  const flow = useBaseUrl('/img/dgw-state-flow.svg');

  return (
    <Layout
      title="Digital Genome Workstation"
      description="Edit human genome variants without changing the source VCF">
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <div className={styles.copy}>
              <p className={styles.kicker}>Digital Genome Workstation</p>
              <h1>Edit a genome.<br /><span>Keep every possibility.</span></h1>
              <p className={styles.lede}>
                DGW turns one selected human VCF sample into a source genome track.
                Duplicate it, apply reversible changes, inspect every allele, and consolidate
                only when you choose to create a new baseline.
              </p>
              <div className={styles.actions}>
                <Link className="button button--primary button--lg" to="/docs/usage/quickstart">
                  Quick start
                </Link>
                <Link className="button button--secondary button--lg" to="/docs/overview">
                  What DGW is
                </Link>
              </div>
              <div className={styles.scope}>
                <span>b37 / hs37d5</span><span>SNVs + short indels</span><span>Runs on your computer</span>
              </div>
            </div>

            <div className={styles.audition} aria-label="Example genome track edit">
              <div className={styles.auditionTitle}><span>TRACK</span>BRAF alternative · 7:140,453,101–171</div>
              <div className={styles.sequence}><b>SRC</b><code>────────── ────────── ───</code></div>
              <div className={styles.sequence}><b>EDIT</b><code>────────── <em>A→T</em> ──────────</code></div>
              <div className={styles.sequence}><b>COPY</b><code>TCCTTTACTT <em>T</em>CTACACCTC AGA</code></div>
              <div className={styles.variant}><span>A › T</span><strong>BRAF · p.Val600Glu</strong></div>
              <div className={styles.evidence}>
                <span>SnpEff <b>found</b></span><span>dbNSFP <b>found</b></span>
                <span>ClinVar <b>found</b></span><span>COSMIC <b>found</b></span>
              </div>
              <div className={styles.states}><i /> device active <i /> edit visible <i className={styles.branch} /> bypass to compare</div>
            </div>
          </div>
        </section>

        <section className={styles.workflow} aria-label="Non-destructive genome track flow">
          <img src={flow} alt="A source genome track is duplicated into experimental tracks with devices and persistent edit blocks, then evaluated, consolidated, or exported" />
          <p>One source track. Many experimental tracks. Visible edits until explicit consolidation.</p>
        </section>

        <section className={styles.sections} aria-label="Documentation sections">
          <div className={styles.grid}>
            {guideLinks.map((guide) => (
              <Link className={styles.card} to={guide.to} key={guide.title}>
                <span>{guide.label}</span><h2>{guide.title}</h2><p>{guide.text}</p>
              </Link>
            ))}
          </div>
        </section>
      </main>
    </Layout>
  );
}
