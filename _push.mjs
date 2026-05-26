import { execSync } from 'child_process';
process.chdir('c:\\edge_workspace\\drive\\street-view-app');
execSync('git add -A', { stdio: 'inherit' });
execSync('git commit -m "docs: add README with project overview and usage"', { stdio: 'inherit' });
execSync('git push', { stdio: 'inherit' });
