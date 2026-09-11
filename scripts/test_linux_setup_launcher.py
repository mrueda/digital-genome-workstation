"""Native launcher checks; never opens a GUI or installs DGW."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class LauncherTest(unittest.TestCase):
    def test_relocation_arguments_and_missing_payload(self):
        with tempfile.TemporaryDirectory(prefix="dgw-native-test-") as work:
            folder = Path(work) / "folder with spaces"
            folder.mkdir()
            launcher = folder / "dgw-setup"
            subprocess.run(["cc", "-Wall", "-Wextra", "-Werror",
                            str(Path(__file__).with_name("linux-setup-launcher.c")),
                            "-o", str(launcher)], check=True)
            payload = folder / ".dgw.AppDir"
            payload.mkdir()
            script = payload / "AppRun"
            script.write_text('#!/bin/sh\nprintf "%s\\n" "$@" "${APPDIR-unset}" "${APPIMAGE-unset}"\n')
            script.chmod(0o755)
            moved = Path(work) / "moved folder"
            shutil.move(folder, moved)
            env = {**os.environ, "APPDIR": "/wrong", "APPIMAGE": "/wrong"}
            result = subprocess.run([str(moved / "dgw-setup"), "--dgw-run", "literal $argument;"],
                                    cwd="/", env=env, text=True, capture_output=True, check=True)
            self.assertEqual(result.stdout.splitlines(), ["--dgw-run", "literal $argument;", "unset", "unset"])
            (moved / ".dgw.AppDir/AppRun").unlink()
            failed = subprocess.run([str(moved / "dgw-setup")], capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("Extract the complete package", failed.stderr)


if __name__ == "__main__":
    unittest.main()
