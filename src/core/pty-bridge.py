#!/usr/bin/env python3
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def _int_env(name, default):
    try:
        return int(os.environ.get(name, default))
    except Exception:
        return default


def _set_winsize(fd, cols, rows):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))
    except Exception:
        pass


def _set_nonblocking(fd):
    try:
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    except Exception:
        pass


def main():
    shell = os.environ.get("CODETREE_PTY_SHELL") or os.environ.get("SHELL") or "/bin/zsh"
    cwd = os.environ.get("CODETREE_PTY_CWD") or os.getcwd()
    cols = _int_env("CODETREE_PTY_COLS", 80)
    rows = _int_env("CODETREE_PTY_ROWS", 24)
    try:
        shell_args = json.loads(os.environ.get("CODETREE_PTY_ARGS") or "[]")
        if not isinstance(shell_args, list):
            shell_args = []
    except Exception:
        shell_args = []

    pid, master_fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
        except Exception:
            os.chdir(os.path.expanduser("~"))
        env = dict(os.environ)
        env["TERM"] = env.get("TERM") or "xterm-color"
        env["COLUMNS"] = str(cols)
        env["LINES"] = str(rows)
        argv = [shell] + [str(a) for a in shell_args]
        os.execvpe(shell, argv, env)

    os.write(2, ("__CODETREE_PTY_PID__=%d\n" % pid).encode("utf-8", "replace"))
    _set_winsize(master_fd, cols, rows)
    _set_nonblocking(0)
    _set_nonblocking(master_fd)
    try:
        _set_nonblocking(3)
        control_fd = 3
    except Exception:
        control_fd = None

    control_buf = b""

    def shutdown(signum, frame):
        try:
            os.kill(pid, signal.SIGHUP)
        except Exception:
            pass
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    while True:
        read_fds = [master_fd, 0]
        if control_fd is not None:
            read_fds.append(control_fd)
        try:
            ready, _, _ = select.select(read_fds, [], [], 0.25)
        except InterruptedError:
            continue

        if master_fd in ready:
            try:
                data = os.read(master_fd, 8192)
            except OSError as e:
                if e.errno == errno.EIO:
                    break
                continue
            if not data:
                break
            try:
                os.write(1, data)
            except OSError:
                break

        if 0 in ready:
            try:
                data = os.read(0, 8192)
            except OSError:
                data = b""
            if data:
                try:
                    os.write(master_fd, data)
                except OSError:
                    break

        if control_fd is not None and control_fd in ready:
            try:
                chunk = os.read(control_fd, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                control_fd = None
            else:
                control_buf += chunk
                while b"\n" in control_buf:
                    line, control_buf = control_buf.split(b"\n", 1)
                    try:
                        msg = json.loads(line.decode("utf-8"))
                        _set_winsize(master_fd, msg.get("cols", cols), msg.get("rows", rows))
                    except Exception:
                        pass

        try:
            ended, status = os.waitpid(pid, os.WNOHANG)
            if ended:
                if os.WIFEXITED(status):
                    return os.WEXITSTATUS(status)
                return 0
        except ChildProcessError:
            return 0

    try:
        os.kill(pid, signal.SIGHUP)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
