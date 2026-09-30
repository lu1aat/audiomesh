/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// Self-signed certificate for the dev server, if one has been generated into
// certs/. getUserMedia needs a secure context, and a phone or another machine
// reaching this one by name or LAN/Tailscale IP only gets one over https.
// Absent files just mean plain http, which is fine on localhost.
const https =
  existsSync('certs/dev-key.pem') && existsSync('certs/dev-cert.pem')
    ? { key: readFileSync('certs/dev-key.pem'), cert: readFileSync('certs/dev-cert.pem') }
    : undefined;

// Same policy as hellschreiber2026: shipped inside index.html so the "no runtime
// network requests" constraint is enforced by the browser on any static host.
// Build only; the dev server needs its own origin for HMR.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'audiochat-csp-meta',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [cspMeta()],
  base: './',
  build: {
    target: 'es2022',
    // Worklets are loaded via `?worker&url` and must stay separate chunks.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  // getUserMedia needs a secure context: localhost works, a LAN IP over http does not.
  server: {
    port: 5173,
    host: true,
    https,
    // Vite refuses requests whose Host header is not localhost or an IP. A
    // tailnet name (`tailscale serve` -> https://machine.tailnet.ts.net) would be
    // blocked without this. Plain IPs and localhost are always allowed.
    allowedHosts: ['.ts.net'],
  },
});
