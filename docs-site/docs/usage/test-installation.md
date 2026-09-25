# Testing a desktop installation

Installers are experimental. Linux ARM64 installation and launch have been checked on an isolated display. The ad-hoc-signed Apple Silicon build has been installed and opened successfully on a real Mac. The Windows x86_64 workflow has installed and launched DGW on a Windows runner; a real Windows 10/11 test is still required.

## Graphical installation

No administrator installation is required. Choose a folder owned by your user.

- **Linux:** extract the matching `dgw-setup-linux-*.tar.gz`, open the extracted `dgw-setup` folder, and double-click the **dgw-setup** executable inside it. Keep the extracted folder together; its hidden `.dgw.AppDir` contains the application. Choose the installation folder, click **Install**, then **Continue to genome setup**. The launcher is a native executable, not a Bash file, and does not need FUSE. Linux may still ask permission to execute downloaded software. Older test packages expose `AppRun` instead: right-click it → **Run as a Program**. The alternative AppImage may require FUSE and executable permission first.
- **macOS:** open the matching DMG (Apple Silicon or Intel) and drag **DGW.app** to **Applications**. Launch the copied app, not the copy inside the disk image. If your account cannot write to the shared Applications folder, use the Applications folder inside your home directory. There is no separate application-installation wizard on macOS; DGW opens genome setup when resources are absent. The Apple Silicon test build has a verified ad-hoc signature and has launched on a real Mac, but Developer ID signing, notarization, Intel testing, and clean-machine behavior still require validation. Do not disable macOS security protections.
- **Windows:** run the setup executable. NSIS is configured for the current user, not a machine-wide installation. Automated testing covers silent installation into a Windows runner's local application data and confirms that the installed app creates a DGW window. The installer is unsigned; a real-machine standard-user test, SmartScreen behavior, and missing-WebView2 behavior remain pending.

The installed application does not require Node.js, Cargo, a development server or the checkout. Its examples are included; genome data and bcftools are separate resource packages. To reinstall on Linux, close DGW and enable **Replace existing installation and shortcut**. Setup preserves the previous application and shortcut in a `dgw-backup-*` folder beside the installation; projects and genome resources are not changed. Unrecognized folders are never replaced. There is not yet an uninstall interface. On macOS, quit DGW and replace the app through Finder; separately stored projects and genome resources remain outside the app bundle.

The manual `installers.yml` workflow builds platform artifacts without publishing them. This is build infrastructure, not evidence that every platform has passed installation tests.

For a macOS-only test build, use **Build macOS test installer**, select Apple Silicon or Intel, and download its workflow artifact. It contains the DMG and SHA-256 checksum. Test builds use an ad-hoc signature. The workflow verifies the complete app signature inside the disk image as well as disk-image integrity; it does not validate a Finder launch on a clean Mac. Ad-hoc signing does not establish an Apple-verified developer identity or provide notarization. macOS approval is still required for downloaded test builds. No Developer ID signing/notarization credentials are configured. A “damaged” warning should be investigated, not bypassed by disabling Gatekeeper or removing quarantine flags.

For a genuine first-install test, use a fresh VM snapshot or a separate Linux user with no previous DGW settings. Installing on your usual account may reuse registered resources and previous projects. Do not delete your working settings or projects to simulate a clean install.

Release builds do not discover the repository's development resource paths. Debug builds retain that convenience.

## First-run checklist

On first launch, if no resources are registered, DGW opens **Step 2: Set up genome resources**. Choose GRCh37 or GRCh38, choose a storage folder, then click **Download and install**. DGW selects matching platform tools automatically and shows download size and progress. After registration, choose **Continue to examples**. **Other installation options** contains downloaded-package and existing-resource options. **Set up later** returns to the landing page, where missing-resource examples link back to setup. The same flow applies after macOS and Windows installation; genome archives are separate from application installers.

1. Launch without running `npm run tauri dev`. Check the logo, menus and landing page.
2. Before installing resources, confirm that DGW does not silently use the developer's genome files.
3. Choose an assembly and a new storage folder, then **Download and install**. To test offline installation instead, use **Other installation options → Install downloaded packages** and select the matching assembly and tools archives.
4. Follow the progress through archive validation, extraction and registration. The assembly should become available on the landing page.
5. Open its matching example. Select an allele and verify that Consequence Predictor returns evidence. Missing optional COSMIC data should be reported as unavailable, not as a startup failure.

### Add optional COSMIC data

In **Settings → Resources → Optional resources · COSMIC**, choose an installed reference profile and your separately obtained COSMIC `.vcf.gz`. Its `.tbi` or `.csi` index must be beside it. Enter the release and confirm that the file matches the profile's genome assembly, then choose **Validate and add COSMIC**. TSV exports are not supported.

DGW checks the VCF header and indexed contigs; this does not prove the assembly. Check the build stated by the data provider. The files remain in their original location and retain their own license terms.

This creates a new reference profile, which you can select when importing a new project. Existing projects keep their recorded resources; adding COSMIC here does not update them.
6. Duplicate a track, make an edit, compare it, save the project and close the application.
7. Reopen the installed application and saved project. Confirm the track and edit remain, then export a VCF to a new destination.

Automatic downloads use the public `mrueda/dgw-data` resource release and pinned checksums; no GitHub login is needed. Older installer builds may still have downloads disabled and need an updated application build. Database files retain their own licenses. See [resource configuration](installation.md#install-genome-resources).

Record the OS/version, CPU architecture, DGW version, resource archive names and any failing step. Building a package or opening its setup window alone is not a completed installation test.

## Linux: Install appears to do nothing after removing an earlier installation

Deleting the application folder does not remove its application-menu shortcut. In the updated installer, enable **Replace existing installation and shortcut**, then click **Install / Replace**. This also replaces a stale shortcut. A recoverable shortcut copy is kept in the backup folder.

Older test installers refuse to replace the shortcut. For those builds only, use the following workaround.

If you have already removed the earlier DGW application folder:

1. Open your file manager and press **Ctrl+L** to edit the location.
2. Open `.local/share/applications` inside your home folder. For example, `/home/mrueda/.local/share/applications`. If you use a custom XDG data directory, open its `applications` folder instead.
3. Find `org.mrueda.dgw-0.1.0.desktop` (the version must match the installer). Some file managers display its name as **Digital Genome Workstation**; check its properties to identify the file.
4. Confirm the shortcut points to the application folder you removed, then move only that shortcut to **Trash**.
5. Return to DGW Setup and click **Install** again.

This removes only the stale menu shortcut, not projects, settings or genome resources. It can be restored from Trash. Do not remove the whole `applications` folder or a shortcut belonging to an installation you still use.

Prefer the updated installer’s replacement option over this manual workaround.

## Continue to genome setup does not open DGW

The updated installer stays open after requesting launch. Close it only once the DGW window appears. Early process exits are reported beside the launch button; output is captured in `setup-launch.log` under the application's local data directory (normally `.local/share/org.mrueda.dgw` inside your Linux home folder). A successful launch request is not confirmation that the window appeared.

If DGW does not appear, open **Digital Genome Workstation** from the applications menu, or right-click the installed `DGW.AppDir/AppRun` → **Run as a Program**. Report the launch log rather than reinstalling repeatedly.

VMs may print DRI3/EGL graphics-acceleration warnings. A missing GStreamer `appsink` warning was also observed in a successful private-display launch; it alone does not establish the cause of a startup failure. Do not install system packages solely to silence these messages. Graphics and multimedia packaging still need clean-machine validation.
