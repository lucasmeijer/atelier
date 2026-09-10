#!/usr/bin/python3
"""Workspace-owned desktop. The supervisor, not Atelier's web process, owns X."""
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path.home() / ".local/state/atelier-desktop"
DISPLAY = ":99"
CDP_PORT = 9222
VNC_PORT = 5900
WEB_PORT = 6080
DETAILS = {"display": DISPLAY, "cdpUrl": f"http://127.0.0.1:{CDP_PORT}", "width": 800, "height": 900}


def request_status():
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(2)
        try:
            client.connect(str(ROOT / "control.sock"))
        except (FileNotFoundError, ConnectionRefusedError):
            with open(ROOT / "runtime.lock", "w") as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return {"phase": "starting"}
            error_file = ROOT / "error.json"
            if error_file.exists():
                return json.loads(error_file.read_text())
            return {"phase": "stopped"}
        with client.makefile("r") as stream:
            return json.loads(stream.readline())


def assert_children(children):
    for name, process in children:
        code = process.poll()
        if code is not None:
            raise RuntimeError(f"{name} exited with code {code}. See {ROOT / 'desktop.log'}")


def wait_ready(probe, children, label):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        assert_children(children)
        if probe():
            return
        time.sleep(0.05)
    raise RuntimeError(f"Timed out waiting for {label}. See {ROOT / 'desktop.log'}")


def cdp_ready():
    # Ignore proxy configuration: CDP never leaves this workspace.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(DETAILS["cdpUrl"] + "/json/version", timeout=1) as response:
            return bool(json.load(response).get("webSocketDebuggerUrl"))
    except (urllib.error.URLError, TimeoutError):
        return False


def port_ready(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except (ConnectionRefusedError, TimeoutError):
        return False


def stop_children(children):
    # Each child owns a process group, including Chromium's subprocesses.
    for _, process in reversed(children):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 3
    for _, process in reversed(children):
        try:
            process.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def supervise(ready_fd):
    children = []
    stopping = False
    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    ready = os.fdopen(ready_fd, "w")
    with open(ROOT / "runtime.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        control = socket.socket(socket.AF_UNIX)
        try:
            (ROOT / "error.json").unlink(missing_ok=True)
            (ROOT / "control.sock").unlink(missing_ok=True)
            # Refuse occupied ports rather than accidentally returning another
            # browser's CDP endpoint or attaching to an unrelated VNC server.
            for port in (CDP_PORT, VNC_PORT, WEB_PORT):
                with socket.socket() as reservation:
                    reservation.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    reservation.bind(("127.0.0.1", port))
            # X uses a private cookie; no TCP listener and no global DISPLAY.
            auth = ROOT / "Xauthority"
            auth.touch(mode=0o600)
            subprocess.run(["xauth", "-f", str(auth), "add", DISPLAY, ".", os.urandom(16).hex()], check=True)
            env = {**os.environ, "DISPLAY": DISPLAY, "XAUTHORITY": str(auth)}
            def launch(name, args):
                if stopping:
                    raise RuntimeError("Desktop startup interrupted")
                process = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, start_new_session=True)
                children.append((name, process))
            launch("Xvfb", ["Xvfb", DISPLAY, "-screen", "0", "800x900x24", "-nolisten", "tcp", "-auth", str(auth), "-noreset"])
            wait_ready(lambda: subprocess.run(["xdpyinfo"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0, children, "Xvfb")
            launch("Openbox", ["openbox", "--config-file", "/opt/atelier/desktop/openbox.xml"])
            wait_ready(lambda: b"_NET_SUPPORTING_WM_CHECK(WINDOW)" in subprocess.check_output(["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"], env=env), children, "Openbox")
            # Suppress the Chrome for Testing banner (also suppresses startup flag warnings).
            launch("Chromium", ["dbus-run-session", "--", "chromium", "--test-type=gpu", "--gtk-version=3", f"--user-data-dir={ROOT / 'profile'}", "--class=AtelierDesktop", "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--start-maximized", "--remote-debugging-address=127.0.0.1", f"--remote-debugging-port={CDP_PORT}", "about:blank"])
            wait_ready(cdp_ready, children, "Chromium CDP")
            launch("x11vnc", ["x11vnc", "-display", DISPLAY, "-auth", str(auth), "-listen", "127.0.0.1", "-rfbport", str(VNC_PORT), "-forever", "-shared", "-nopw", "-noxdamage", "-xkb"])
            wait_ready(lambda: port_ready(VNC_PORT), children, "VNC")
            launch("websockify", ["websockify", "--heartbeat", "30", f"127.0.0.1:{WEB_PORT}", f"127.0.0.1:{VNC_PORT}"])
            wait_ready(lambda: port_ready(WEB_PORT), children, "VNC WebSocket")
            status = {"phase": "running", "pid": os.getpid(), "xauthority": str(auth), **DETAILS}
            control.bind(str(ROOT / "control.sock"))
            control.listen()
            ready.write(json.dumps(status) + "\n")
            ready.close()
            while not stopping:
                assert_children(children)
                readable, _, _ = select.select([control], [], [], 0.2)
                if readable:
                    connection, _ = control.accept()
                    with connection:
                        try:
                            connection.sendall((json.dumps(status) + "\n").encode())
                        except (BrokenPipeError, ConnectionResetError):
                            # A cancelled status request must not kill the desktop.
                            continue
        except Exception as error:
            status = {"phase": "failed", "error": str(error)}
            (ROOT / "error.json").write_text(json.dumps(status))
            if not ready.closed:
                ready.write(json.dumps(status) + "\n")
                ready.close()
            print(str(error), file=sys.stderr, flush=True)
        finally:
            control.close()
            (ROOT / "control.sock").unlink(missing_ok=True)
            stop_children(children)


def start():
    with open(ROOT / "start.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        status = request_status()
        if status["phase"] == "running":
            return status
        if status["phase"] == "starting":
            wait_ready(lambda: request_status()["phase"] != "starting", [], "desktop supervisor")
            status = request_status()
            if status["phase"] == "running":
                return status
        read_fd, write_fd = os.pipe()
        with open(ROOT / "desktop.log", "a") as log:
            process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "supervise", str(write_fd)], pass_fds=(write_fd,), stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        os.close(write_fd)
        with os.fdopen(read_fd) as ready:
            if not select.select([ready], [], [], 90)[0]:
                process.terminate()
                process.wait(timeout=10)
                raise RuntimeError(f"Desktop startup timed out. See {ROOT / 'desktop.log'}")
            response = ready.readline()
            if not response:
                process.wait(timeout=10)
                raise RuntimeError(f"Desktop supervisor exited during startup. See {ROOT / 'desktop.log'}")
            result = json.loads(response)
        if result["phase"] == "failed":
            process.wait(timeout=10)
        return result


def stop():
    with open(ROOT / "start.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        status = request_status()
        if status["phase"] == "starting":
            wait_ready(lambda: request_status()["phase"] != "starting", [], "desktop supervisor")
            status = request_status()
        if status["phase"] == "running":
            os.kill(status["pid"], signal.SIGTERM)
            with open(ROOT / "runtime.lock", "w") as runtime_lock:
                fcntl.flock(runtime_lock, fcntl.LOCK_EX)
        (ROOT / "error.json").unlink(missing_ok=True)
        return {"phase": "stopped"}


def main():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    command = sys.argv[1]
    if command == "supervise":
        supervise(int(sys.argv[2]))
        return
    if command not in ("start", "status", "stop"):
        raise ValueError("Usage: atelier-desktop start|status|stop")
    result = {"start": start, "status": request_status, "stop": stop}[command]()
    print(json.dumps(result))
    if result["phase"] == "failed":
        sys.exit(1)


if __name__ == "__main__":
    main()
