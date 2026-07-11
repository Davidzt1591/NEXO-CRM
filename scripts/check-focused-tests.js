const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FOCUSED_TEST_PATTERN = /\b(?:test|describe|it)\.only\s*\(/;
const IGNORED_DIRS = new Set(['node_modules', 'coverage', 'dist', 'build', '.git', '.next', '.vite']);
const TARGETS = [
  { dir: path.join(ROOT, 'backend', 'test'), file: /\.test\.js$/ },
  { dir: path.join(ROOT, 'scripts'), file: /\.test\.js$/ },
  { dir: path.join(ROOT, 'frontend', 'src'), file: /\.(?:test|spec)\.[cm]?[jt]sx?$/ },
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir, filePattern, files = []) {
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, filePattern, files);
    } else if (filePattern.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

const offenders = [];

for (const target of TARGETS) {
  for (const file of walk(target.dir, target.file)) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    if (!FOCUSED_TEST_PATTERN.test(source)) continue;

    offenders.push(path.relative(ROOT, file));
  }
}

if (offenders.length > 0) {
  console.error('Focused tests are not allowed in committed test files:');
  for (const file of offenders) console.error(`- ${file}`);
  process.exit(1);
}

console.log('Focused test guard passed.');
