import { defineConfig } from 'vite';

function localShutdown() {
  return {
    name: 'local-server-shutdown',
    configureServer(server) {
      server.middlewares.use('/__shutdown', (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405).end();
          return;
        }
        const address = request.socket.remoteAddress ?? '';
        let originHost = null;
        try {
          originHost = request.headers.origin ? new URL(request.headers.origin).hostname : null;
        } catch {
          originHost = 'invalid';
        }
        const foreignOrigin = originHost !== null && !['localhost', '127.0.0.1', '[::1]'].includes(originHost);
        if (foreignOrigin || (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1')) {
          response.writeHead(403).end();
          return;
        }
        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end('{"stopping":true}');
        setTimeout(() => {
          server.close().catch((error) => {
            console.error('Local server shutdown failed:', error);
          });
        }, 100);
      });
    },
  };
}

export default defineConfig({
  root: 'src',
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    open: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [localShutdown()],
});
