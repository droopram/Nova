"""Static dev server for the Nova TV app with caching disabled."""
import functools
import os
import http.server
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
root = sys.argv[2] if len(sys.argv) > 2 else "."
handler = functools.partial(NoCache, directory=root)
# Localhost only: this serves the whole folder. Use NOVA_DEV_HOST=0.0.0.0 to open it to the LAN.
host = os.environ.get("NOVA_DEV_HOST", "127.0.0.1")
http.server.ThreadingHTTPServer((host, port), handler).serve_forever()
