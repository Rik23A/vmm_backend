const fs = require('fs');
const path = require('path');

// Determine log directory:
// 1. If drive G: exists (Dedicated Log drive on host PC), use G:/vmm_logs
// 2. If drive F: exists, use F:/vmm_logs
// 3. Fallback to local logs folder inside backend
let logDir = 'G:/vmm_logs';
if (!fs.existsSync('G:/')) {
  logDir = fs.existsSync('F:/') ? 'F:/vmm_logs' : path.join(__dirname, 'logs');
}

// Automatically create the directory if it does not exist (zero manual setup needed)
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    console.error(`Could not create log directory at ${logDir}, falling back to local logs.`, err);
    logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  }
}

module.exports = {
  apps: [
    {
      name: 'vmm-app',
      script: 'app.js',
      cwd: __dirname,
      instances: 'max', // Uses all available CPU cores in cluster mode
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
      max_memory_restart: '600M',
      error_file: path.join(logDir, 'error.log').replace(/\\/g, '/'),
      out_file: path.join(logDir, 'out.log').replace(/\\/g, '/'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      autorestart: true,
      watch: false,
    },
  ],
};
