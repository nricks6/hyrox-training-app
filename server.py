#!/usr/bin/env python3
"""
Simple HTTP server for the Scott training tracker PWA.
Run with: python server.py
Serves on http://localhost:8766
"""

import http.server
import socketserver

PORT = 8766

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Add headers for PWA support
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

if __name__ == '__main__':
    with socketserver.TCPServer(('', PORT), Handler) as httpd:
        print(f'Scott Training Tracker')
        print(f'Serving at http://localhost:{PORT}')
        print(f'Press Ctrl+C to stop')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nShutting down...')
