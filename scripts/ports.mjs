import net from 'node:net';

export function checkPort(port, host = '127.0.0.1') {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      reject(new Error(error.code === 'EADDRINUSE'
        ? `Port ${port} on ${host} is already in use. No existing process was stopped. Use the running app, or stop it with its original launcher/process manager first.`
        : `Cannot use ${host}:${port}: ${error.message}`));
    });
    server.listen({ port, host, exclusive: true }, () => server.close(resolve));
  });
}
