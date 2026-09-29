import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './index.module.css';
import {videoLibrary} from '../data/videos';

const guides = [
  {title: 'Try an example', text: 'Open a prepared project, edit an allele and compare the result.', to: '/docs/usage/quickstart'},
  {title: 'Choose a device', text: 'Randomize selected variants, search alternative ALTs or morph between tracks.', to: '/docs/usage/device-guide'},
  {title: 'Understand results', text: 'Read predictions, exact database matches and the Track Monitor.', to: '/docs/usage/evaluate-alleles'},
  {title: 'Develop and automate', text: 'Build from source, connect an MCP client or inspect the methods.', to: '/docs/technical-details/'},
];

export default function Home() {
  const workspace = useBaseUrl('/img/devices/workspace.png');
  const publishedVideos = videoLibrary.videos.filter(video => video.url);
  const showVideos = Boolean(publishedVideos.length || videoLibrary.channelUrl || videoLibrary.playlistUrl);
  return (
    <Layout title="Digital Genome Workstation" description="Edit genome variants, compare alternatives and keep the source VCF intact.">
      <main className={styles.page}>
        <div className={styles.intro}>
        <section className={styles.hero}>
          <p className={styles.kicker}>A workstation for genome editing</p>
          <h1>One genome.<br /><span>Different possibilities.</span></h1>
          <p className={styles.lede}>Open a sample VCF, keep alternative tracks and explore reversible edits with predictions and database evidence.</p>
          <div className={styles.actions}>
            <Link className={styles.install} to="/docs/usage/installation">Install DGW <span aria-hidden="true">↓</span></Link>
            <Link className={styles.example} to="/docs/usage/quickstart">Try an example <span aria-hidden="true">→</span></Link>
          </div>
          <p className={styles.platforms}>Linux · macOS · Windows &nbsp; / &nbsp; GRCh37 + GRCh38</p>
        </section>
        <figure className={styles.product}>
          <div className={styles.previewHeader}><span>The workspace</span><span>DGW v0.1</span></div>
          <a href={workspace}><img src={workspace} alt="DGW showing source and editable genome tracks, devices, Track Monitor and focused-allele evidence" /></a>
          <figcaption><span>Synthetic example</span><a href={workspace}>View full size ↗</a></figcaption>
        </figure>
        </div>
        <section className={styles.sections} aria-label="Choose a guide">
          <div className={styles.sectionHeading}><h2>Start with a question. Try a change.</h2><p>Keep the source. Compare the result.</p></div>
          <div className={styles.grid}>
            {guides.map((guide, index) => <Link className={styles.card} to={guide.to} key={guide.title}><span className={styles.guideNumber} aria-hidden="true">0{index + 1}</span><h3>{guide.title} <span aria-hidden="true">↗</span></h3><p>{guide.text}</p></Link>)}
          </div>
          {showVideos && <section className={styles.videos} aria-labelledby="video-heading">
            <div className={styles.sectionHeading}>
              <h2 id="video-heading">Watch DGW in action</h2>
              <div className={styles.videoLinks}>
                {videoLibrary.playlistUrl && <a href={videoLibrary.playlistUrl}>Watch the playlist ↗</a>}
                {videoLibrary.channelUrl && <a href={videoLibrary.channelUrl}>YouTube channel ↗</a>}
              </div>
            </div>
            {videoLibrary.playlistPrivate && <p>The playlist is currently private. Videos will be available here when published.</p>}
            <div className={styles.videoGrid}>
              {publishedVideos.map(video => <a className={styles.video} href={video.url} key={video.id}>
                <span className={styles.play} aria-hidden="true">▷</span>
                <div><span className={styles.guideNumber}>Tutorial {video.id}</span><h3>{video.title}</h3><p>{video.description}</p></div>
              </a>)}
            </div>
          </section>}
          <div className={styles.context}><p>Tracks, editors and plugins.<br /><span>Inspired by music workstations, built for variants.</span></p><Link to="/docs/about/origin-and-development">Why a workstation? →</Link></div>
          <p className={styles.note}>For research. Predictions evaluate alleles independently; scores are not disease probabilities.</p>
        </section>
      </main>
    </Layout>
  );
}
