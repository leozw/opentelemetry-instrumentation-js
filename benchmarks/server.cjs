const http = require('node:http');

const port = parseInt(process.env.BENCHMARK_PORT || '4400', 10);

const server = http.createServer((_req, res) => {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end('{"ok":true}');
});

server.listen(port, '127.0.0.1', () => {
  // Printed for parent process readiness probe.
  // eslint-disable-next-line no-console
  console.log(`benchmark-server-ready:${server.address().port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
