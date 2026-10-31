#!/usr/bin/env python3
"""Launch the SMB Simulator Suite in your web browser.

    python run_suite.py            # opens http://127.0.0.1:8050
    python run_suite.py --port 9000 --no-browser
"""
import argparse
import sys
import threading
import webbrowser

try:
    import numpy  # noqa: F401
except ImportError:
    sys.exit("NumPy is required. Install it with:  python -m pip install numpy")

from webapp.server import serve


def main():
    ap = argparse.ArgumentParser(description="SMB Simulator Suite")
    ap.add_argument("--port", type=int, default=8050)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    try:
        httpd = serve(a.host, a.port)
    except OSError:
        sys.exit(f"Port {a.port} is busy. Try:  python run_suite.py --port {a.port + 1}")
    url = f"http://{a.host}:{a.port}"
    print(f"SMB Simulator Suite running at {url}  (press Ctrl+C to stop)")
    if not a.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
