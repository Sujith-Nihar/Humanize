"""Verify upstream provenance, task coverage and local documentation links."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]
spec = ROOT / 'docs/spec/Humanize_Final_Engineering_Build_Spec.md'
assert hashlib.sha256(spec.read_bytes()).hexdigest() == 'e4f7ad1d7638beccfb052c55b22d22c465784bd3dd9c8a1e73a7afdb1f209900'
upstream = set(re.findall(r'^\| (P1-S\d+-\d{3}) \|', spec.read_text(), re.M))
manifest = json.loads((ROOT / 'docs/implementation/manifest.json').read_text())
tasks = [task for stage in manifest['stages'] for task in stage['tasks']]
assert len({task['id'] for task in tasks}) == len(tasks)
assert upstream == {item for task in tasks for item in task['upstream']}
for task in tasks:
    path = ROOT / f'docs/implementation/tasks/{task["id"]}.md'
    assert path.is_file(), path
    if task['status'] == 'complete':
        assert 'pending' not in path.read_text().split('## Completion evidence')[-1].lower(), path
for path in [ROOT / 'README.md', ROOT / 'AGENTS.md', ROOT / 'CLAUDE.md', *ROOT.glob('docs/**/*.md')]:
    if path == spec:
        continue
    for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
        if '://' in target or target.startswith('#'):
            continue
        target = target.split('#')[0]
        assert (path.parent / target).exists(), f'{path}: broken link {target}'
print(f'Documentation verified: {len(upstream)} upstream tasks, {len(tasks)} execution tasks; preserved spec unchanged.')
