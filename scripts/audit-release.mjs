// Release hygiene scan. Findings contain locations and categories, never values.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const excludedDirectories = new Set(['.git', '.codex', 'target', 'node_modules', 'dist', 'release', 'out', '.orchestration', 'native', 'raw_frontend', '__pycache__', '2026-11-16', 'NVIDIA Corporation']);
const excludedFiles = new Set(['AGENTS.md', 'PROGRESS.md', 'BLOCKED.md', 'SUMMARY.md', 'frontend/src/original/providerUiTransforms.ts']);
const textExtensions = new Set(['.rs', '.lock', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.toml', '.yaml', '.yml', '.md', '.ps1', '.py', '.html', '.css', '.svg', '.txt', '.sh', '.gitignore']);
const findings = [];
const reviewedExamples = [];
const counts = { files: 0, bytes: 0, consoleLog: 0, emails: 0, urls: 0 };
const emailDomains = new Map();
const endpointHosts = new Map();
const personalRoot = os.homedir().replaceAll('\\', '/').toLowerCase();
const rules = [
  ['credential-token', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/gu],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
  ['jwt', /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu],
  ['assigned-secret', /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|authorization|cookie|password)["']?\s*[:=]\s*["']([^"'\r\n]{16,})["']/giu],
  ['url-credentials', /https?:\/\/[^/\s:"'<>@]+:[^/\s"'<>@]+@[^/\s"'<>]+/giu],
  ['local-user-path', /[A-Z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/giu],
];
function sample(value) {
  return /(?:example|placeholder|your[_ -]|process\.env|REDACTED|\$\{|<[^>]+>|xxxxxxxx|\.repeat\(|\.join\(|\{\{|token_here|\.{3}|…|meeting-password|my-temporalcloud-api-key|zaraz-consent)/iu.test(value)
    || /^https?:\/\/user(?:name)?:pass(?:word)?@yourapp\.com(?:\/|$)/iu.test(value);
}
async function walk(directory) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const filename = path.join(directory, item.name);
    const relative = path.relative(root, filename).replaceAll('\\', '/');
    if (excludedFiles.has(relative)) continue;
    if (item.isDirectory()) {
      if (!excludedDirectories.has(item.name)) await walk(filename);
      continue;
    }
    if (!item.isFile() || (!textExtensions.has(path.extname(item.name)) && !['.gitignore', '.npmrc', '.netrc', '.env.example'].includes(item.name))) continue;
    const source = await fs.readFile(filename, 'utf8');
    counts.files++;
    counts.bytes += Buffer.byteLength(source);
    for (const [category, pattern] of rules) {
      for (const match of source.matchAll(pattern)) {
        if (sample(match[0]) || (category === 'local-user-path' && /Users[\\/]+(?:me\b|\[username\])/iu.test(match[0]))) {
          reviewedExamples.push({ file: relative, category });
          continue;
        }
        findings.push({ file: relative, line: 1 + source.slice(0, match.index).split('\n').length - 1, category });
      }
    }
    if (source.replaceAll('\\\\', '/').replaceAll('\\', '/').toLowerCase().includes(personalRoot)) findings.push({ file: relative, category: 'personal-home-path' });
    const ownCode = /^(?:electron\/[^/]+\.(?:js|mjs)|frontend\/src\/|shared\/|scripts\/)/u.test(relative);
    if (ownCode && !relative.startsWith('scripts/')) counts.consoleLog += [...source.matchAll(/console\.(?:log|debug)\s*\(/gu)].length;
    for (const match of source.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/gu)) {
      if (/^(?:2x|3x)[.-]/u.test(match[1])) continue; // Asset scale suffix, not email.
      counts.emails++;
      emailDomains.set(match[1], (emailDomains.get(match[1]) ?? 0) + 1);
    }
    for (const match of source.matchAll(/https?:\/\/([A-Za-z0-9.-]+)(?::\d+)?/gu)) {
      counts.urls++;
      if (ownCode) endpointHosts.set(match[1], (endpointHosts.get(match[1]) ?? 0) + 1);
    }
  }
}
await walk(root);
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
const ignoredTracked = git(['ls-files', '-ci', '--exclude-standard', '-z']).split('\0').filter(Boolean);
const pending = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
const nestedBackend = pending.filter(filename => /^backend_official(?:\/|$)/u.test(filename));
const candidates = pending.filter(filename => !nestedBackend.includes(filename));
const report = {
  generatedAt: new Date().toISOString(), counts, findings, reviewedExamples,
  emailDomains: Object.fromEntries(emailDomains), ownCodeEndpointHosts: Object.fromEntries(endpointHosts),
  trackedFiles: tracked.length, ignoredButTracked: ignoredTracked,
  pendingGithubCandidates: candidates.length, excludedBackendEntries: nestedBackend,
  scopeExclusions: [...excludedDirectories, ...excludedFiles],
};
await fs.mkdir(path.join(root, 'out'), { recursive: true });
await fs.writeFile(path.join(root, 'out/release-audit.json'), JSON.stringify(report, null, 2) + '\n');
await fs.writeFile(path.join(root, 'out/pending-github-files.txt'), candidates.join('\n') + '\n');
const outsideBackend = findings.filter(finding => !finding.file.startsWith('backend_official/'));
console.log(JSON.stringify({ counts, findingsOutsideReadOnlyBackend: outsideBackend, readOnlyBackendMatches: findings.length - outsideBackend.length, trackedFiles: tracked.length, ignoredButTracked: ignoredTracked, pendingGithubCandidates: candidates.length, report: 'out/release-audit.json', candidateList: 'out/pending-github-files.txt' }, null, 2));
if (ignoredTracked.length || outsideBackend.length) process.exitCode = 1;
