import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const deployConfigPath = resolve('.wrangler/deploy/config.json');

if (!existsSync(deployConfigPath)) {
  process.exit(0);
}

const deployConfig = JSON.parse(readFileSync(deployConfigPath, 'utf8'));
if (!deployConfig.configPath || typeof deployConfig.configPath !== 'string') {
  process.exit(0);
}

const wranglerConfigPath = resolve('.wrangler/deploy', deployConfig.configPath);

if (!existsSync(wranglerConfigPath)) {
  process.exit(0);
}

const rawConfig = JSON.parse(readFileSync(wranglerConfigPath, 'utf8'));

const sanitizedConfig = {
  name: rawConfig.name,
  main: rawConfig.main,
  compatibility_date: rawConfig.compatibility_date,
  compatibility_flags: rawConfig.compatibility_flags,
  d1_databases: rawConfig.d1_databases,
  vars: rawConfig.vars,
};

// Remove undefined keys while keeping a minimal, Pages-compatible config.
for (const key of Object.keys(sanitizedConfig)) {
  if (sanitizedConfig[key] === undefined) {
    delete sanitizedConfig[key];
  }
}

writeFileSync(wranglerConfigPath, `${JSON.stringify(sanitizedConfig)}\n`, 'utf8');
