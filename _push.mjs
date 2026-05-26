import { execSync } from 'child_process';
import { unlinkSync, existsSync } from 'fs';

process.chdir('c:\\edge_workspace\\drive\\street-view-app');

const toDelete = [
  'test-cdp.mjs', 'test-cdp2.mjs', 'test-cdp3.mjs',
  'test-google-route.mjs',
  'test-steering.mjs', 'test-steering2.mjs', 'test-steering3.mjs',
  'test-steering4.mjs', 'test-steering5.mjs', 'test-steering6.mjs',
  'collect-streetview.mjs',
];

for (const f of toDelete) {
  if (existsSync(f)) { unlinkSync(f); console.log('deleted', f); }
  else { console.log('already gone', f); }
}

execSync('git add -A', { stdio: 'inherit' });
execSync('git commit -m "chore: remove test/experiment scripts"', { stdio: 'inherit' });
execSync('git push', { stdio: 'inherit' });
