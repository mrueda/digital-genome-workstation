# Testing a desktop installation

This checklist is for developers and release testers. For everyday installation, follow [Install DGW](installation.md).

## Recorded validation

Linux ARM64 installation and launch have been checked on an isolated display. The ad-hoc-signed Apple Silicon build has been installed and opened on a real Mac. The Windows x86_64 workflow installs and launches DGW on a Windows runner; a real Windows 10/11 test is still required. Intel Mac and clean-machine coverage remain incomplete.

## Prepare a test

Use an installer from the [public releases](https://github.com/mrueda/digital-genome-workstation/releases), or the **dgw-release-assets** artifact from the manual **Build installers** workflow. Verify it against the accompanying **SHA256SUMS**. The workflow builds packages without publishing them.

For a first-install test, use a fresh VM or a separate user account without DGW settings. Existing settings may reuse registered resources and projects. Keep your working data intact.

Follow the [platform installation instructions](installation.md#install-the-app). The installed application should work without Node.js, Cargo, a development server or the source checkout. Examples are bundled; genome resources and bcftools are separate downloads.

## First-run checklist

1. Launch the installed app. Check the logo, menus and landing page.
2. Confirm that genome setup appears when no resources are registered and that the release build does not use development resource paths.
3. Choose an assembly and a new storage folder, then **Download and install**. Check progress through download, validation, extraction and registration.
4. Choose **Continue to examples**, open a matching example, and verify that Consequence Predictor returns predictions. Missing optional COSMIC data should not prevent startup.
5. Duplicate a track, make an edit, compare it, save the project and close the application.
6. Reopen the application and project. Confirm the track and edit remain, then export a VCF to a new destination.
7. Repeat resource setup using **Other installation options → Install downloaded packages** with the matching assembly and tools archives.

If testing COSMIC, follow [Add COSMIC](resources.md#add-cosmic). Confirm that the new profile is available for new projects and that existing projects retain their recorded resources.

## Reinstallation and launch checks

On Linux, close DGW and enable **Replace existing installation and shortcut**. Verify that the launcher works and that the previous application and shortcut are backed up. On macOS, quit DGW and replace the app through Finder. Check that saved projects and separately stored resources remain available.

The Linux installer should stay open after **Continue to genome setup** until the DGW window appears. Failed launches should report an error; startup output is normally in `~/.local/share/org.mrueda.dgw/setup-launch.log`. See [Troubleshooting](../reference/troubleshooting.md#installation-or-launch-failed).

The macOS workflow checks the app's ad-hoc signature and disk-image integrity. It does not establish Developer ID trust, notarization or a successful Finder launch on a clean Mac. Windows runner tests likewise do not establish standard-user installation or SmartScreen behavior on a real machine.

Record the OS/version, CPU architecture, DGW version, resource archive names, completed checks and any failing step. A successful package build alone is not a completed installation test.
