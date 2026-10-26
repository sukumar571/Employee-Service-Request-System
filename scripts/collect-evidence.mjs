#!/usr/bin/env node
/**
 * Collects genuine verification evidence into `evidence/`.
 *
 * Every file written here is the real stdout/stderr of a command that was executed on this
 * machine, plus live responses captured from a running API. Nothing is fabricated: if a step
 * fails, the failure is written down and this script exits non-zero.
 *
 *   npm run evidence                 # quality gates + API probes (expects servers to be running)
 *   npm run evidence -- --no-api     # quality gates only
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(repoRoot, 'evidence');
const apiDir = path.join(evidenceDir, 'api-responses');
const screenshotDir = path.join(evidenceDir, 'screenshots');
const skipApi = process.argv.slice(2).includes('--no-api');

const API_BASE = process.env.EVIDENCE_API_URL ?? 'http://localhost:4000/api/v1';
const WEB_BASE = process.env.EVIDENCE_WEB_URL ?? 'http://localhost:5173';

const checks = [
  { file: '01-tool-versions.txt', command: 'node', args: () => ['-e', VERSION_SNIPPET] },
  { file: '02-eslint.txt', command: 'npm', args: ['run', 'lint'] },
  { file: '03-prettier-check.txt', command: 'npm', args: ['run', 'format:check'] },
  { file: '04-typecheck.txt', command: 'npm', args: ['run', 'typecheck'] },
  { file: '05-tests.txt', command: 'npm', args: ['run', 'test'] },
  { file: '06-build.txt', command: 'npm', args: ['run', 'build'] },
];

const probes = [
  { file: 'api-index.json', url: `${API_BASE}` },
  { file: 'health-live.json', url: `${API_BASE}/health/live` },
  { file: 'health-ready.json', url: `${API_BASE}/health/ready` },
  { file: 'meta.json', url: `${API_BASE}/meta` },
  {
    file: 'sla-policies.json',
    url: `${API_BASE}/sla/policies`,
    // Expected until Phase 5 ships authentication: the identity gate fails closed.
    note: 'expected - identity gate fails closed until Phase 5 ships auth',
  },
  {
    file: 'sla-policy-update-unauthenticated.json',
    url: `${API_BASE}/sla/policies/critical`,
    method: 'PUT',
    note: 'expected - a write attempt without a token is rejected',
    body: {
      first_response_minutes: 30,
      resolution_minutes: 240,
      reason: 'evidence probe from collect-evidence.mjs',
    },
  },
  {
    file: 'unknown-route-404.json',
    url: `${API_BASE}/does-not-exist`,
    note: 'expected - centralized NOT_FOUND envelope for unknown routes',
  },
];

/** Caption for each hand-captured screenshot, keyed by file name. */
const SCREENSHOT_NOTES = {
  '07-screenshot-overview-dashboard.png':
    'Overview page reading live `/meta` and health contracts from the API',
  '08-screenshot-lifecycle-resolved.png':
    'Lifecycle page driving the shared transition table (state set to `resolved`)',
  '09-screenshot-sla-policies-unauthenticated.png':
    'SLA policy page showing the intended fail-closed `UNAUTHENTICATED` / HTTP 401 notice',
  '10-screenshot-overview-second-capture.png':
    'Overview page, re-captured to confirm a stable render',
};

/** Printed verbatim so the evidence shows which toolchain produced the results. */
const VERSION_SNIPPET = [
  'const v = process.version;',
  "const run = (c) => { try { return require('node:child_process').execSync(c, { encoding: 'utf8' }).trim(); } catch { return 'unavailable'; } };",
  "console.log('node       ' + v);",
  "console.log('npm        ' + run('npm --version'));",
  "console.log('git        ' + run('git --version'));",
  "console.log('platform   ' + require('node:os').platform() + ' ' + require('node:os').release());",
].join(' ');

await mkdir(apiDir, { recursive: true });

const results = [];

/** Runs a command, stores its combined output next to a machine-readable status line. */
async function runCheck(file, { command, args: argsOrThunk }) {
  const args = typeof argsOrThunk === 'function' ? argsOrThunk() : argsOrThunk;
  // `npm` is npm.cmd on Windows and cmd.exe needs a shell; every other command (node -e "<code>")
  // is spawned directly so its arguments survive quoting. Passing args alongside `shell: true`
  // triggers DEP0190, so the shell variant receives one pre-joined command line instead.
  const useShell = command === 'npm' && process.platform === 'win32';
  const options = {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: useShell,
    maxBuffer: 64 * 1024 * 1024,
    // Colour codes would make the archived text unreadable in a report, so they are switched off.
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  };
  const result = useShell
    ? spawnSync([command, ...args].join(' '), options)
    : spawnSync(command, args, options);
  const output = `${command} ${args.join(' ')}\n\n${result.stdout ?? ''}${result.stderr ?? ''}`;
  const status = result.error
    ? `ERROR ${result.error.message}`
    : `exit code ${result.status ?? 'null'}`;
  await writeFile(path.join(evidenceDir, file), `${output}\n[${status}]\n`, 'utf8');
  const ok = !result.error && result.status === 0;
  results.push({ name: file, ok, status });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file}  (${status})`);
  return ok;
}

/** Captures a live HTTP response — status line, headers of interest and the parsed body. */
async function runProbe({ file, url, method = 'GET', body, note }) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: body
        ? { 'content-type': 'application/json', accept: 'application/json' }
        : { accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 2000) };
    }
    const payload = {
      request: { method, url },
      response: {
        status: response.status,
        status_text: response.statusText,
        headers: Object.fromEntries(
          ['content-type', 'x-request-id', 'x-content-type-options', 'cache-control'].map(
            (name) => [name, response.headers.get(name)],
          ),
        ),
        elapsed_ms: Date.now() - started,
        body: parsed,
      },
    };
    if (note) payload.explanation = note;
    await writeFile(path.join(apiDir, file), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    const status = note ? `HTTP ${response.status} - ${note}` : `HTTP ${response.status}`;
    results.push({ name: `api/${file}`, ok: true, status });
    console.log(`CAPTURED  api/${file}  (${status})`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(
      path.join(apiDir, file),
      `${JSON.stringify({ request: { method, url }, error: message }, null, 2)}\n`,
      'utf8',
    );
    results.push({ name: `api/${file}`, ok: false, status: message });
    console.log(`MISS      api/${file}  (${message})`);
    return false;
  }
}

/** Confirms the SPA is being served and its bundle is reachable. */
async function probeWeb() {
  const file = 'web-index.html';
  try {
    const response = await fetch(WEB_BASE, { headers: { accept: 'text/html' } });
    const html = await response.text();
    const hasRoot = html.includes('id="root"');
    const hasEntry = html.includes('/src/main.tsx') || html.includes('assets/');
    await writeFile(
      path.join(apiDir, file),
      `${JSON.stringify(
        {
          request: { method: 'GET', url: WEB_BASE },
          response: {
            status: response.status,
            has_root_element: hasRoot,
            has_module_entry: hasEntry,
          },
          html_start: html.slice(0, 1200),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const ok = response.ok && hasRoot && hasEntry;
    results.push({ name: `api/${file}`, ok, status: `HTTP ${response.status}` });
    console.log(`${ok ? 'PASS' : 'FAIL'}  api/${file}  (HTTP ${response.status})`);
    return ok;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name: `api/${file}`, ok: false, status: message });
    console.log(`MISS      api/${file}  (${message})`);
    return false;
  }
}

for (const check of checks) {
  await runCheck(check.file, check);
}

if (!skipApi) {
  for (const probe of probes) {
    await runProbe(probe);
  }
  await probeWeb();
}

/**
 * Lists the browser screenshots kept beside the automated artifacts. They are captured by hand
 * (not by this script), so they are reported as an inventory rather than as a pass/fail check.
 */
async function collectScreenshots() {
  try {
    const entries = await readdir(screenshotDir);
    return entries.filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort();
  } catch {
    return [];
  }
}

const screenshots = await collectScreenshots();

const lines = [
  '# Verification evidence',
  '',
  `Generated by \`node scripts/collect-evidence.mjs${skipApi ? ' --no-api' : ''}\` on ${new Date().toISOString()}.`,
  '',
  'Each file in this directory is the verbatim output of the command named in its first line.',
  '`api-responses/` holds live HTTP captures taken against the running API and portal.',
  '',
  '| Artifact | Result | Detail |',
  '| --- | --- | --- |',
  ...results.map((item) => `| \`${item.name}\` | ${item.ok ? 'pass' : 'fail'} | ${item.status} |`),
  '',
  `**${results.filter((item) => item.ok).length}/${results.length} artifacts captured successfully.**`,
  '',
];

if (screenshots.length > 0) {
  lines.push(
    '## Screenshots',
    '',
    'Captured from the running portal in a browser (`http://localhost:5173`); these are the only',
    'artifacts not produced by a command, so they are listed rather than re-generated here.',
    '',
    '| Screenshot | Shows |',
    '| --- | --- |',
    ...screenshots.map(
      (name) => `| \`screenshots/${name}\` | ${SCREENSHOT_NOTES[name] ?? 'portal view'} |`,
    ),
    '',
  );
} else {
  lines.push(
    '## Screenshots',
    '',
    'No screenshots found in `evidence/screenshots/`. Capture the portal in a browser and add them',
    'there; the next run of `npm run evidence` will index them automatically.',
    '',
  );
}

await writeFile(path.join(evidenceDir, 'README.md'), `${lines.join('\n')}\n`, 'utf8');

const failed = results.filter((item) => !item.ok);
console.log(
  `\nEvidence written to ${path.relative(process.cwd(), evidenceDir) || '.'} (${results.length - failed.length}/${results.length} ok)`,
);
if (failed.length > 0) process.exitCode = 1;
