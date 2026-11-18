import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function activeAdvisories(audit, lookup) {
  if (audit.error) throw new Error(audit.error.summary || 'npm audit failed');
  const vulnerabilities = audit.vulnerabilities || {};
  const roots = new Map();
  for (const [name, finding] of Object.entries(vulnerabilities)) {
    for (const via of finding.via || []) {
      if (typeof via === 'string') {
        if (!vulnerabilities[via]) throw new Error('Unresolved advisory dependency: ' + name);
      } else {
        const id = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(via.url || '')?.[0];
        if (!id) throw new Error('Cannot verify advisory without a GitHub advisory ID');
        roots.set(id, via);
      }
    }
  }
  if (Object.keys(vulnerabilities).length && !roots.size) throw new Error('Missing root advisory details');
  const active = [];
  const withdrawn = [];
  for (const [id, finding] of roots) {
    const current = await lookup(id);
    if (!current || current.ghsa_id !== id) throw new Error('Advisory verification failed: ' + id);
    if (current.withdrawn_at) withdrawn.push(id);
    else active.push({ id, title: finding.title, url: finding.url });
  }
  return { active, withdrawn };
}

async function main() {
  const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, shell: process.platform === 'win32' });
  if (result.error || ![0, 1].includes(result.status)) throw new Error(result.error?.message || 'npm audit could not complete');
  const audit = JSON.parse(result.stdout);
  const findings = await activeAdvisories(audit, async id => {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
    const response = await fetch('https://api.github.com/advisories/' + id, { headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Cannot verify advisory ' + id + ': HTTP ' + response.status);
    return response.json();
  });
  for (const item of findings.active) console.error(item.id + ': ' + item.title + ' ' + item.url);
  for (const id of findings.withdrawn) console.log(id + ': withdrawn by GitHub; excluded from the active count');
  console.log(findings.active.length + ' active advisory roots');
  if (findings.active.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
