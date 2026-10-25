const fs = require('node:fs');
const path = require('node:path');
const cwd = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(cwd, '.env'))) process.loadEnvFile(path.join(cwd, '.env'));
const configPath = process.env.CLASSIFIER_CONFIG_PATH || '/data/users/s22101440/mingocell-classifier-runtime/server.json';
const settings = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const timeout = settings.timeout ?? 120;
if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('Invalid classifier timeout.');

module.exports = {
  apps: [{
    name: 'mingocell-classification-worker',
    cwd,
    script: path.join(cwd, 'dist/cli/classification-worker.js'),
    interpreter: process.execPath,
    node_args: '--env-file-if-exists=.env',
    instances: 1,
    exec_mode: 'fork',
    kill_timeout: timeout * 1000 + 90_000,
    restart_delay: 5000,
    env: { NODE_ENV: 'production' },
  }],
};
