"""Check packaged setup on a private virtual display, never the user's desktop."""
import argparse
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
import ctypes


def handoff(display, auth, folder, env, window):
    # Explicit private display only; never use the desktop's DISPLAY.
    os.environ["XAUTHORITY"] = str(auth)
    x = ctypes.CDLL("libX11.so.6")
    t = ctypes.CDLL("libXtst.so.6")
    x.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x.XOpenDisplay.restype = ctypes.c_void_p
    d = x.XOpenDisplay(display.encode())
    if not d:
        raise RuntimeError("Cannot connect to private test display")
    x.XStringToKeysym.argtypes = [ctypes.c_char_p]
    x.XStringToKeysym.restype = ctypes.c_ulong
    x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x.XKeysymToKeycode.restype = ctypes.c_uint
    x.XFlush.argtypes = [ctypes.c_void_p]
    x.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    x.XSetInputFocus(d, int(window, 16), 2, 0)
    t.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    t.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    t.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    def key(name, down):
        t.XTestFakeKeyEvent(d, x.XKeysymToKeycode(d, x.XStringToKeysym(name.encode())), down, 0)
        x.XFlush(d)
        time.sleep(.02)
    def click(px, py):
        t.XTestFakeMotionEvent(d, -1, px, py, 0)
        t.XTestFakeButtonEvent(d, 1, 1, 0)
        t.XTestFakeButtonEvent(d, 1, 0, 0)
        x.XFlush(d)
        time.sleep(.3)
    click(220, 205)
    key("Control_L", 1); key("a", 1); key("a", 0); key("Control_L", 0)
    for char in str(folder / "installed"):
        name = {"/": "slash", "-": "minus", "_": "underscore"}.get(char, char)
        if char == "_": key("Shift_L", 1)
        key(name, 1); key(name, 0)
        if char == "_": key("Shift_L", 0)
    # From the path input: folder picker, replace checkbox, install button.
    for _ in range(3):
        key("Tab", 1); key("Tab", 0)
    key("Return", 1); key("Return", 0)
    target = folder / "installed/DGW-0.1.0/DGW.AppDir/AppRun"
    for _ in range(150):
        if target.exists():
            break
        time.sleep(.2)
    time.sleep(2)
    subprocess.run(["import", "-display", display, "-window", "root", str(folder / "installed.png")], env=env, check=True)
    if not target.exists():
        raise RuntimeError(f"Install click did not create {target}; see installed.png")
    # Installation disables the action and drops keyboard focus.
    click(160, 490)
    time.sleep(5)
    subprocess.run(["import", "-display", display, "-window", "root", str(folder / "handoff.png")], env=env, check=True)
    windows = subprocess.run(["xwininfo", "-root", "-tree"], env=env, capture_output=True, text=True, check=True).stdout
    if '"Digital Genome Workstation"' not in windows:
        raise RuntimeError(f"DGW did not open after Continue; see {folder}/handoff.png and app.log")
    if '"DGW Setup"' not in windows:
        raise RuntimeError("Installer unexpectedly closed during handoff")
    print(f"native_install_and_handoff=passed diagnostics={folder}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--xvfb", type=Path, required=True)
    parser.add_argument("application", type=Path)
    parser.add_argument("--handoff", action="store_true")
    args = parser.parse_args()
    application = args.application.resolve(strict=True)
    folder = Path(tempfile.mkdtemp(prefix="dgw-setup-check-"))
    display = next(f":{n}" for n in range(90, 110) if not Path(f"/tmp/.X11-unix/X{n}").exists() and not Path(f"/tmp/.X{n}-lock").exists())
    auth = folder / "Xauthority"
    auth.touch(mode=0o600)
    subprocess.run(["xauth", "-f", str(auth), "add", display, ".", secrets.token_hex(16)], check=True)
    env = dict(os.environ)
    for key in ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "APPDIR", "APPIMAGE"):
        env.pop(key, None)
    env.update(DISPLAY=display, XAUTHORITY=str(auth), GDK_BACKEND="x11", LIBGL_ALWAYS_SOFTWARE="1", WEBKIT_DISABLE_DMABUF_RENDERER="1")
    for key, child in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("XDG_RUNTIME_DIR", "runtime")):
        (folder / child).mkdir(mode=0o700)
        env[key] = str(folder / child)
    processes = []
    try:
        with (folder / "display.log").open("w") as log:
            processes.append(subprocess.Popen([str(args.xvfb.resolve()), display, "-screen", "0", "1600x1000x24", "-auth", str(auth), "-nolisten", "tcp"], stdout=log, stderr=log, env=env))
        for _ in range(50):
            if Path(f"/tmp/.X11-unix/X{display[1:]}").exists():
                break
            time.sleep(.1)
        else:
            raise RuntimeError(f"Private display did not start; see {folder}")
        with (folder / "app.log").open("w") as log:
            processes.append(subprocess.Popen(["dbus-run-session", "--", str(application)], stdout=log, stderr=log, env=env, cwd=folder))
        for _ in range(100):
            windows = subprocess.run(["xwininfo", "-root", "-tree"], env=env, capture_output=True, text=True, check=True).stdout
            match = re.search(r'(0x[0-9a-f]+) "DGW Setup"', windows)
            if match:
                time.sleep(2)
                subprocess.run(["import", "-display", display, "-window", match[1], str(folder / "setup.png")], env=env, check=True)
                print(f"native_setup_window=passed diagnostics={folder}")
                if args.handoff:
                    handoff(display, auth, folder, env, match[1])
                break
            if processes[-1].poll() is not None:
                raise RuntimeError(f"Setup exited before opening; see {folder}/app.log")
            time.sleep(.2)
        else:
            raise RuntimeError(f"Setup window did not appear; see {folder}")
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    main()
