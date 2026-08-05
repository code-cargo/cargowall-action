"""Policy-API stub for the api-failure e2e jobs.

Serves the given status for every GET (the policy fetch). POST (the post-step
summary push) always gets 200 so push noise never pollutes the job log — the
stub exists to drive the FETCH failure classes, not to assert pushes.
"""
import http.server
import sys

status = int(sys.argv[1])


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{}')

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        self.rfile.read(length)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{}')

    def log_message(self, *args):
        pass


http.server.HTTPServer(('127.0.0.1', 8099), Handler).serve_forever()
