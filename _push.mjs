import { execSync } from 'child_process';
process.chdir('c:\\edge_workspace\\drive\\street-view-app');
execSync('git add .', { stdio: 'inherit' });
execSync('git commit -m "chore: cleanup"', { stdio: 'inherit' });
execSync('git push', { stdio: 'inherit' });
