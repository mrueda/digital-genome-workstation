"""Package the dependency-bundled Linux AppDir without requiring FUSE at launch."""
import argparse
import hashlib
import tarfile
import os
import shlex
import subprocess
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("appdir", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    root = args.appdir.resolve(strict=True)
    if not (root / "AppRun").is_file() or not (root / "usr/bin/dgw-desktop").is_file():
        parser.error("Expected a Tauri-built DGW AppDir")
    # Preserve internal relative links, never package references into the build host.
    for path in root.rglob("*"):
        if path.is_symlink() and (path.readlink().is_absolute() or not path.resolve(strict=True).is_relative_to(root)):
            parser.error(f"External or absolute symlink: {path}")
    with tempfile.TemporaryDirectory(prefix="dgw-launcher-") as work:
        launcher = Path(work) / "dgw-setup"
        subprocess.run([*shlex.split(os.environ.get("CC", "cc")), "-Os", "-Wall", "-Wextra", "-Werror",
                        str(Path(__file__).with_name("linux-setup-launcher.c")), "-o", str(launcher)], check=True)
        # Prevent accidental mixing of host-built launchers and cross-built payloads.
        def elf_machine(path):
            with path.open("rb") as binary:
                header = binary.read(20)
            if len(header) != 20 or header[:4] != b"\x7fELF" or header[5] not in (1, 2):
                raise ValueError(f"Expected a Linux ELF executable: {path}")
            return int.from_bytes(header[18:20], "little" if header[5] == 1 else "big")
        if elf_machine(launcher) != elf_machine(root / "usr/bin/dgw-desktop"):
            parser.error("Launcher and DGW architectures differ; set CC to the matching compiler")
        with args.output.open("xb") as output:
            with tarfile.open(fileobj=output, mode="w:gz", dereference=False) as archive:
                archive.add(launcher, arcname="dgw-setup/dgw-setup")
                archive.add(root, arcname="dgw-setup/.dgw.AppDir")
    with args.output.open("rb") as package:
        digest = hashlib.file_digest(package, "sha256").hexdigest()
    with Path(str(args.output) + ".sha256").open("x") as checksum:
        checksum.write(f"{digest}  {args.output.name}\n")
    print(args.output)


if __name__ == "__main__":
    main()
