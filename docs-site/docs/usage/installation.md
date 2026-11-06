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

Downloads are public; no GitHub account is required. Platform validation details are recorded in [installer validation](test-installation.md).

### Optional download verification

Download **SHA256SUMS** from the same release. It lists the SHA-256 checksum for each installer. Run the command for your platform, replacing `FILE` with your downloaded installer:

| Platform | Command |
| --- | --- |
| Linux | `sha256sum FILE` |
| macOS | `shasum -a 256 FILE` |
| Windows PowerShell | `Get-FileHash FILE -Algorithm SHA256` |

Compare the result with the matching filename in **SHA256SUMS** (hexadecimal letter case does not matter). Checksums detect damaged or changed downloads; they do not replace code signing.

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

The macOS release is ad-hoc signed and not notarized. After a blocked launch, macOS may offer **Open Anyway** in **System Settings → Privacy & Security**, with authentication required. Approve only the app you intentionally downloaded. Report a “damaged” warning rather than disabling Gatekeeper. [Apple's guidance](https://support.apple.com/en-us/102445).

</TabItem>
<TabItem value="windows" label="Windows">

1. Run the downloaded `…-setup.exe`.
2. Follow the graphical setup, using the per-user location or a folder you own.
3. Open **Digital Genome Workstation** from Start.
4. Continue with genome setup.

The Windows installer is unsigned. Real-machine Windows validation is still pending; report unexpected administrator requests or security blocks. Do not disable Windows security protections.

</TabItem>
</Tabs>

Projects and genome resources are stored separately from the application.

<details className="alert alert--info">
<summary><strong>Where DGW stores internal application data</strong></summary>

DGW keeps internal settings and app-managed files here:

- **Linux:** `~/.local/share/org.mrueda.dgw/` (or `$XDG_DATA_HOME/org.mrueda.dgw/` if configured).
- **macOS:** `~/Library/Application Support/org.mrueda.dgw/`.
- **Windows:** `%LOCALAPPDATA%\org.mrueda.dgw\`.

It contains interface and resource preferences, registered resource profiles, setup diagnostics and, unless you choose another location, downloaded resources. Saved `.dgw` projects and resources stored elsewhere are not kept here. Deleting this folder resets DGW and removes resources installed in its default location.

</details>

## Install genome resources

On first launch, choose **GRCh37** or **GRCh38**, a storage folder, then **Download and install**. The assembly must match your VCF. When setup completes, choose **Continue to examples**.

DGW chooses the matching tools for your computer and verifies the downloads. For offline installation or optional COSMIC, see [Genome resources](resources.md).

## Check for updates

Use **Help → Check for updates**. DGW checks the latest public stable version and links to GitHub releases; you download and install the new version yourself.

The update check compares version numbers; another build of the same version is not reported as an update. Genome resource versions remain recorded separately in projects.

Next: [Try an example](quickstart.md). Having trouble? [Troubleshooting](../reference/troubleshooting.md).
