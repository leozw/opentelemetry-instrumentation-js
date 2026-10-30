const http = require('node:http');
const counts = { traces: 0, metrics: 0, bytes: 0 };
const server = http.createServer((req, res) => {
  req.on('data', chunk => { counts.bytes += chunk.length; });
  req.on('end', () => {
    if (req.url === '/v1/traces') counts.traces++;
    if (req.url === '/v1/metrics') counts.metrics++;
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    res.end();
  });
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('message', message => {
  if (message === 'stats') process.send({ counts, usage: process.resourceUsage() });
});
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
