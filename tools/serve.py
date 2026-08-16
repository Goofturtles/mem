"""Static server for mem's test harness and dashboard preview.

Two reasons this exists instead of `python -m http.server`:

1. No cache headers. http.server sends none, so Chrome applies heuristic
   caching to ES modules. During iteration that means an edited module keeps
   loading from cache — including, once, a mid-edit copy that failed to parse
   long after the file on disk was correct. Everything here is no-store, and
   because no-store also stops Chrome sending If-Modified-Since, 304s never
   arise to complicate matters.

2. Dual-stack binding. Chrome resolves `localhost` to ::1 before 127.0.0.1 on
   Windows, so an IPv4-only socket produces a connection failure that looks
   exactly like a dead server.
"""

import socket
import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    # On Windows, mimetypes reads the registry, and a broken or missing key
    # for .js makes it return an empty Content-Type. Chrome then refuses the
    # file outright: "Expected a JavaScript-or-Wasm module script but the
    # server responded with a MIME type of ''." Pinning the handful of types
    # this project serves removes the dependency on the machine's registry.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.wasm': 'application/wasm',
        '': 'application/octet-stream',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


class DualStackServer(HTTPServer):
    """Accepts both IPv6 and IPv4 loopback connections."""
    address_family = socket.AF_INET6

    def server_bind(self):
        # Clearing IPV6_V6ONLY is what makes a single ::  socket also answer
        # 127.0.0.1, so it doesn't matter which family the browser picks.
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        super().server_bind()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3492
    directory = sys.argv[2] if len(sys.argv) > 2 else '.'
    handler = partial(NoCacheHandler, directory=directory)
    # Loopback only. '::' would also accept connections from the local
    # network, and this serves a development build of an extension that reads
    # the user's browsing history.
    try:
        server = DualStackServer(('::1', port), handler)
    except OSError:
        server = HTTPServer(('127.0.0.1', port), handler)
    print(f'serving {directory} on http://localhost:{port} (no-store, dual-stack)', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
