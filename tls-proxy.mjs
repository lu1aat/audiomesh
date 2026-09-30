// TLS front for PHP's built-in server (see web.sh). PHP cannot speak TLS.
//
// One port answers both schemes: a connection whose first byte is 0x16 (TLS
// handshake) is decrypted and piped to PHP on loopback; anything else is taken
// as plain http and redirected to https, instead of the connection reset a
// TLS-only listener gives a browser that tried http:// first.
//
// Usage: node tls-proxy.mjs <host> <port> <cert> <key> <innerPort>

import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

const [host, port, certPath, keyPath, innerPort] = process.argv.slice(2);
const TLS_HANDSHAKE = 0x16;

const secure = tls.createServer(
  { cert: readFileSync(certPath), key: readFileSync(keyPath) },
  (client) => {
    const upstream = net.connect(Number(innerPort), '127.0.0.1');
    client.pipe(upstream).pipe(client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close);
    upstream.on('error', close);
  },
);
// A browser that rejects the self-signed certificate aborts the handshake.
secure.on('tlsClientError', () => {});

const redirect = http.createServer((req, res) => {
  const hostHeader = req.headers.host ?? `localhost:${port}`;
  res.writeHead(301, { Location: `https://${hostHeader}${req.url ?? '/'}` });
  res.end();
});

net
  .createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.once('readable', () => {
      const first = socket.read(1);
      if (first === null) return socket.destroy();
      socket.unshift(first);
      const target = first[0] === TLS_HANDSHAKE ? secure : redirect;
      target.emit('connection', socket);
    });
  })
  .listen(Number(port), host.replace(/^\[(.*)\]$/, '$1'));
