const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const os = require('node:os');

function isWindows() {
  return os.platform() === 'win32';
}

function getPm2Home() {
  return process.env.PM2_HOME || path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'pm2', 'home');
}

function readPm2Log(tailLines = 30) {
  if (!isWindows()) {
    return { path: null, content: 'PM2 log reading is only supported on Windows.' };
  }
  const pm2Home = getPm2Home();
  const candidates = [
    path.join(pm2Home, 'logs', 'pm2.log'),
    path.join(pm2Home, 'pm2.log'),
    path.join('C:\\ProgramData', 'pm2', 'pm2.log'),
  ];
  for (const logPath of candidates) {
    if (fs.existsSync(logPath)) {
      try {
        const lines = execSync(
          `powershell -NoProfile -Command "Get-Content '${logPath}' -Tail ${tailLines}"`,
          { encoding: 'utf-8', timeout: 10000 }
        );
        return { path: logPath, content: lines };
      } catch (err) {
        return { path: logPath, content: `Could not read log file: ${err.message}` };
      }
    }
  }
  return { path: null, content: 'No PM2 log file found at expected locations.' };
}

function readEventLog(providerName = 'PM2', maxEvents = 10) {
  if (!isWindows()) {
    return 'Windows Event Log reading is only supported on Windows.';
  }
  try {
    const output = execSync(
      `powershell -NoProfile -Command "` +
        `Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2} -MaxEvents 100 -ErrorAction SilentlyContinue | ` +
        `Where-Object { \$_.Message -like '*pm2*' -or \$_.ProviderName -like '*${providerName}*' } | ` +
        `Select-Object -First ${maxEvents} | ` +
        `ForEach-Object { \"[$($_.TimeCreated)] [$($_.ProviderName)] $($_.Message)\" }"`,
      { encoding: 'utf-8', timeout: 15000 }
    );
    return output.trim() || 'No matching events found.';
  } catch (err) {
    return `Could not read Windows Event Log: ${err.message}`;
  }
}

function getServiceStatus(serviceName = 'PM2') {
  if (!isWindows()) {
    return 'UNKNOWN';
  }
  try {
    const output = execSync(
      `powershell -NoProfile -Command "(Get-Service -Name '${serviceName}' -ErrorAction SilentlyContinue).Status"`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    return output.trim() || 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

function printDiagnostics() {
  console.log('=== PM2 Service Diagnostics ===');
  console.log(`Service Status: ${getServiceStatus('PM2')}`);
  console.log('');
  console.log('--- Windows Event Log (PM2) ---');
  console.log(readEventLog('PM2', 10));
  console.log('');
  const log = readPm2Log(30);
  console.log(`--- PM2 Log (${log.path || 'not found'}) ---`);
  console.log(log.content);
  console.log('');
  console.log('=== Troubleshooting commands ===');
  console.log("  Get-Service PM2");
  console.log("  Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2} -MaxEvents 50 | Where-Object { $_.Message -like '*pm2*' }");
  console.log("  $Env:PM2_HOME = 'C:\\ProgramData\\pm2\\home'");
  console.log("  pm2 list");
  console.log("  pm2 logs");
}

module.exports = {
  isWindows,
  getPm2Home,
  readPm2Log,
  readEventLog,
  getServiceStatus,
  printDiagnostics,
};
