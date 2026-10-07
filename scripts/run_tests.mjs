import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('Running web tests (Vitest)...');
execSync('npm --prefix apps/web test', { stdio: 'inherit', cwd: rootDir });

console.log('\nRunning Python tests (Pytest)...');
const isWin = process.platform === 'win32';
const venvPytest = isWin
  ? path.join(rootDir, '.venv', 'Scripts', 'pytest.exe')
  : path.join(rootDir, '.venv', 'bin', 'pytest');

let pytestCmd;
if (fs.existsSync(venvPytest)) {
  pytestCmd = `"${venvPytest}"`;
} else {
  pytestCmd = isWin ? 'python -m pytest' : 'python3 -m pytest';
}

execSync(pytestCmd, { stdio: 'inherit', cwd: rootDir });
console.log('\nAll tests passed successfully!');
