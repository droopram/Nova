"""Receives Nova's dev log beacons from the TV and prints them.

Dev only. Listens on the LAN (the TV has to reach it); stop it when you are done debugging.
"""
import http.server
import sys


class Log(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
        print(body, flush=True)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 8799), Log).serve_forever()
