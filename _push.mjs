import { execSync } from 'child_process';
process.chdir('c:\\edge_workspace\\drive\\street-view-app');
execSync('git add -A', { stdio: 'inherit' });
execSync('git commit -m "docs: detail AI hybrid navigation architecture"', { stdio: 'inherit' });
execSync('git push', { stdio: 'inherit' });
