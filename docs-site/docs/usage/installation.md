# Install DGW

Install the application, then download genome resources inside DGW. Release builds do not require Rust, Node.js or Java.

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

## Download from GitHub

Open [DGW releases](https://github.com/mrueda/digital-genome-workstation/releases), choose a release, and expand **Assets**. Download an installer, not the automatically generated Source code archives.

| Computer | Package |
| --- | --- |
| Linux, Intel/AMD 64-bit | `dgw-setup-linux-x86_64…tar.gz` |
| Linux, ARM64 | `dgw-setup-linux-aarch64…tar.gz` |
| Mac, Apple Silicon | `dgw-macos-apple-silicon.dmg` |
| Mac, Intel | `dgw-macos-intel.dmg` |
| Windows, Intel/AMD 64-bit | Windows `…-setup.exe` |

:::note[Test releases]
While the application repository is private, sign in with an account that has access. A prerelease may contain only some platforms. Read its release notes; platform test status is recorded in [installer validation](test-installation.md).
:::

## Install the app

<Tabs groupId="installation-os">
<TabItem value="linux" label="Linux" default>

1. Extract the `.tar.gz` in your file manager.
2. Open the extracted **dgw-setup** folder and double-click **dgw-setup**. Allow execution if the file manager asks.
3. Choose a folder you own and click **Install**.
4. Click **Continue to genome setup**; close the installer once DGW appears.

Keep the extracted folder together: its hidden folder contains the application. No sudo or FUSE is required. Later, open **Digital Genome Workstation** from the applications menu.

To reinstall, close DGW, choose the existing installation's parent folder, and enable **Replace existing installation and shortcut**. Setup keeps a recoverable backup of the old application and shortcut.

</TabItem>
<TabItem value="macos" label="macOS">

1. Open the `.dmg`.
2. Drag **DGW.app** into **Applications**.
3. Eject the disk image and open the copied app.
4. Continue with genome setup.

Use the Applications folder inside your home directory if you cannot write to the shared one. To update, quit DGW and replace the app through Finder.

Current test builds are ad-hoc signed and not notarized. After a blocked launch, macOS may offer **Open Anyway** in **System Settings → Privacy & Security**, with authentication required. Approve only the app you intentionally downloaded. Report a “damaged” warning rather than disabling Gatekeeper. [Apple's guidance](https://support.apple.com/en-us/102445).

</TabItem>
<TabItem value="windows" label="Windows">

1. Run the downloaded `…-setup.exe`.
2. Follow the graphical setup, using the per-user location or a folder you own.
3. Open **Digital Genome Workstation** from Start.
4. Continue with genome setup.

The test installer is unsigned. Real-machine Windows validation is still pending; report unexpected administrator requests or security blocks. Do not disable Windows security protections.

</TabItem>
</Tabs>

Projects and genome resources are stored separately from the application.

## Install genome resources

On first launch, choose **GRCh37** or **GRCh38**, a storage folder, then **Download and install**. The assembly must match your VCF. When setup completes, choose **Continue to examples**.

DGW chooses the matching tools for your computer and verifies the downloads. For offline installation or optional COSMIC, see [Genome resources](resources.md).

## Check for updates

Use **Help → Check for updates**. DGW checks the latest public stable version and links to GitHub releases; you download and install the new version yourself.

With a private repository or only prereleases, open releases in your browser instead. Replacing a test build with another build of the same version is not detected. Genome resource versions remain recorded separately in projects.

Next: [Try an example](quickstart.md). Having trouble? [Troubleshooting](../reference/troubleshooting.md).
