const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const port = Number(process.env.PORT || 3000);

function requestHealth() {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          resolve(response.statusCode === 200 && health.application === 'healthy');
        } catch {
          resolve(false);
        }
      });
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

async function start() {
  if (await requestHealth()) {
    console.log(`Knowledge Studio is already running at http://localhost:${port}`);
    console.log('Open the link above instead of starting a second server.');
    return;
  }

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });
  child.on('error', error => {
    console.error('[Start] Failed to launch Knowledge Studio:', error.message);
    process.exitCode = 1;
  });
  child.on('exit', code => { process.exitCode = code || 0; });
}

start();
