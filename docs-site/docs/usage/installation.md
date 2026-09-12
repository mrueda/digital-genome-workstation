# Install DGW

Install the application first, then download genome resources inside DGW. You do not need Rust, Node.js, Java or a terminal to use a release build.

## Download from GitHub

Open [DGW releases](https://github.com/mrueda/digital-genome-workstation/releases), select a release, and expand **Assets**. Download the installer for your operating system and processor—not GitHub's automatically generated **Source code** archives.

DGW is currently being tested privately. Sign in with a GitHub account that has access to the application repository and open the latest prerelease. A development prerelease may contain only some platforms. If your installer is absent, it is not available yet.

| Computer | Download |
| --- | --- |
| Linux, Intel/AMD 64-bit | `dgw-setup-linux-x86_64…tar.gz` |
| Linux, ARM64 | `dgw-setup-linux-aarch64…tar.gz` |
| Mac, Apple Silicon (M-series) | `dgw-macos-apple-silicon.dmg` |
| Mac, Intel | `dgw-macos-intel.dmg` |
| Windows, Intel/AMD 64-bit | Windows `…-setup.exe` |

Test filenames may include an additional build suffix. Read the release notes for the matching version, validation status and known issues. Linux ARM64 installation and Apple Silicon Mac launch have been tested. The Windows x86_64 workflow has installed and launched DGW on a Windows runner; a real Windows 10/11 test is still pending. A built installer is not the same as a tested installation.

## Linux

1. Extract the downloaded `.tar.gz` using your file manager.
2. Open the extracted **dgw-setup** folder.
3. Double-click the **dgw-setup** executable inside it. Confirm execution if your file manager asks. Keep the folder together: a hidden folder contains the application files.
4. Choose an installation folder you own and click **Install**. No sudo or system-wide installation is required.
5. Click **Continue to genome setup**. Close the installer once DGW appears.

The native launcher does not require FUSE. Older test packages used an `AppRun` script; for those, right-click **AppRun → Run as a Program** rather than opening it as text.

After installation, launch **Digital Genome Workstation** from your applications menu.

### Reinstall or replace a test build

Close DGW, open the new installer, select the existing installation's parent folder, and enable **Replace existing installation and shortcut**. Click **Install / Replace**. The installer keeps the previous application and shortcut in a `dgw-backup-*` folder beside the installation. Your projects and genome resources are not replaced.

This option also handles a leftover shortcut after removing an earlier application folder. Do not delete your settings or genome resources to reinstall the app.

## macOS

1. Open the downloaded `.dmg`.
2. Drag **DGW.app** into **Applications**.
3. Eject the disk image and open the copied **DGW** from Applications.
4. Continue with genome resources when prompted.

If you cannot write to the shared Applications folder, use an Applications folder inside your home directory. The app bundle contains the application and its bundled dependencies; genome data is downloaded separately.

To replace a build, quit DGW and replace **DGW.app** through Finder. Projects and genome data remain outside the app bundle.

Current Mac test builds have a verified ad-hoc signature, but are not Developer ID signed or notarized. After attempting to open DGW, macOS may offer **Open Anyway** under **System Settings → Privacy & Security**. Only approve the DGW test app you intentionally downloaded. macOS may request administrator authentication to authorize this security exception; DGW itself does not request elevated privileges. If the app is reported as damaged, stop and report the message. Do not disable Gatekeeper or remove quarantine flags. See [Apple's guidance](https://support.apple.com/en-us/102445).

## Windows

1. Open the downloaded Windows `…-setup.exe`.
2. Follow the graphical setup and keep the per-user installation location, or choose a folder you own.
3. Finish setup and open **Digital Genome Workstation** from the Start menu.
4. Continue with genome resources when prompted.

The installer is configured for the current user rather than a machine-wide installation. Automated testing has installed it into the runner user's local application data and observed the DGW window. The test build remains unsigned; real-machine testing must still cover standard-user installation, SmartScreen, first launch, and a machine without a preinstalled WebView2 runtime. If Windows blocks an unsigned test build or unexpectedly requests administrator access, stop and report the message; do not disable security protections.

## Check for application updates

Choose **Help → Check for updates**. DGW compares its installed version with the latest public stable release. **Open GitHub releases** opens your browser so you can choose and install the package for your computer. It does not download or install an update automatically, and no project or genome data is sent.

While the repository is private—or only prereleases exist—the check cannot confirm the latest version. Open releases in your browser and sign in instead. Replaced test installers with the same application version are not detected. Genome resource versions are separate and remain recorded in your projects.

## Install genome resources

On first launch, DGW opens **Set up genome resources**:

1. Choose **GRCh37** or **GRCh38**, matching your VCF. DGW does not convert between assemblies.
2. Choose a storage folder with enough free space. You can use another drive; the screen shows download size and storage guidance.
3. Click **Download and install**. DGW chooses the tools for your computer automatically, downloads the files from the public resource release, verifies them, and registers the completed installation.
4. When ready, click **Continue to examples**.

No GitHub login is needed for genome downloads. You can add the other assembly later under **Settings → Resources**. **Other installation options** provides offline package installation and registration of existing resources. COSMIC is optional and distributed separately; it is not required for editing or consequence prediction.

## If something goes wrong

- **An example says it requires resources:** finish setup for that assembly.
- **Download interrupted:** retry. Completed verified files are reused; a partial download restarts.
- **Installer did not open DGW:** launch it from the applications menu. On Linux, startup output is saved in `setup-launch.log` under DGW's local application-data folder, normally `.local/share/org.mrueda.dgw` inside your home folder.
- **Reinstallation reports an existing shortcut:** use the updated installer's replacement option. See the [older-build workaround](test-installation.md#linux-install-appears-to-do-nothing-after-removing-an-earlier-installation) if needed.

Next: [Quick Start](quickstart.md). Building or modifying DGW? Use the [Developer Guide](../technical-details/developer-guide.md) instead.
