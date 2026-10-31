"""Local web server for the SMB Simulator Suite (Python standard library only)."""
from __future__ import annotations

import json
import math
import threading
import uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import numpy as np

from smbsim.config import MAX_COLUMNS, MAX_ZONES
from smbsim import SMBConfig, default_case, preset, PRESETS, Simulator, Cancelled, ISOTHERMS, __version__

STATIC = Path(__file__).parent / "static"
MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
        ".json": "application/json"}

SCHEME_INFO = {
    "original": {
        "label": "Original",
        "summary": "Finite differences on a node grid clustered over the dead-volume length at each column inlet. "
                   "Dead volume shapes the grid only; it adds no hold-up.",
    },
    "conservative": {
        "label": "Conservative",
        "summary": "Finite-volume scheme written in conservative (flux) form, so component mass balances cell by cell. "
                   "Dead volume is modelled as an open (unpacked) tube section at every column inlet.",
    },
}


def _clean(o):
    """Make results JSON-safe and compact."""
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.ndarray):
        a = np.where(np.abs(o) < 1e-12, 0.0, o)
        return _clean(np.round(a.astype(float), 6).tolist())
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return None if not math.isfinite(f) else round(f, 8)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


class Job:
    def __init__(self, cfg: SMBConfig):
        self.id = uuid.uuid4().hex[:10]
        self.cfg = cfg
        self.status = "running"
        self.progress = None
        self.result = None
        self.error = None
        self.cancelled = False
        self.lock = threading.Lock()
        threading.Thread(target=self._work, daemon=True).start()

    def _work(self):
        try:
            sim = Simulator(self.cfg)
            res = sim.run(progress=self._on_progress, cancel=lambda: self.cancelled)
            with self.lock:
                self.result = _clean(res)
                self.status = "done"
        except Cancelled:
            with self.lock:
                self.status = "cancelled"
        except Exception as e:  # report any failure to the UI
            with self.lock:
                self.error = str(e)
                self.status = "error"

    def _on_progress(self, p):
        with self.lock:
            self.progress = _clean(p)

    def snapshot(self):
        with self.lock:
            return {"id": self.id, "status": self.status, "progress": self.progress,
                    "result": self.result, "error": self.error}


JOBS: dict[str, Job] = {}


class Handler(BaseHTTPRequestHandler):
    server_version = "SMBSuite/" + __version__

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/defaults":
            return self._send(200, {
                "config": default_case().to_dict(),
                "isotherms": {k: {kk: vv for kk, vv in v.items() if kk != "fn"} for k, v in ISOTHERMS.items()},
                "schemes": SCHEME_INFO, "version": __version__, "max_columns": MAX_COLUMNS, "max_zones": MAX_ZONES,
                "presets": {k: {"label": v[0], "summary": v[1], "config": preset(k).to_dict()} for k, v in PRESETS.items()}})
        if path.startswith("/api/job/"):
            job = JOBS.get(path.rsplit("/", 1)[-1])
            return self._send(200, job.snapshot()) if job else self._send(404, {"error": "unknown job"})
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        f = (STATIC / rel).resolve()
        if STATIC.resolve() in f.parents and f.is_file():
            return self._send(200, f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"))
        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "invalid JSON"})
        if path == "/api/validate" or path == "/api/run":
            try:
                cfg = SMBConfig.from_dict(payload)
            except Exception as e:
                return self._send(400, {"errors": [f"Could not read the configuration: {e}"]})
            errs = cfg.validate()
            if path == "/api/validate":
                try:
                    derived = _clean(cfg.derived())
                except Exception:
                    derived = None
                return self._send(200, {"errors": errs, "derived": derived})
            if errs:
                return self._send(400, {"errors": errs})
            for old in [k for k, j in JOBS.items() if j.status != "running"][:-20]:
                JOBS.pop(old, None)
            job = Job(cfg)
            JOBS[job.id] = job
            return self._send(200, {"id": job.id})
        if path == "/api/normalize":
            try:
                return self._send(200, {"config": SMBConfig.from_dict(payload).to_dict()})
            except Exception as e:
                return self._send(400, {"errors": [f"Could not read the configuration: {e}"]})
        if path.startswith("/api/job/") and path.endswith("/cancel"):
            job = JOBS.get(path.split("/")[3])
            if job:
                job.cancelled = True
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})


def serve(host="127.0.0.1", port=8050):
    httpd = ThreadingHTTPServer((host, port), Handler)
    return httpd
