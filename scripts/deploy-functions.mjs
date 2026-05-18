#!/usr/bin/env node
/**
 * Deploy all Edge Functions to Supabase Cloud.
 *
 * Usage:
 *   node scripts/deploy-functions.mjs              # deploy all
 *   node scripts/deploy-functions.mjs nodes search # deploy specific functions
 *
 * Requires:
 *   - supabase CLI in PATH
 *   - already linked to a project (`supabase link --project-ref ...`)
 */

import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FN_DIR = join(__dirname, '..', 'supabase', 'functions');

/** Functions that must skip Supabase's JWT auth (they verify themselves). */
const NO_JWT = new Set([
  'billing-webhook',
  'connectors-gmail-auth',
  'connectors-gcal-auth',
  'connectors-slack-auth',
  'connectors-notion-auth',
  'process-node',
  'account-wipe-worker',
  'connectors-gmail-sync',
  'connectors-gcal-sync',
  'connectors-slack-sync',
  'connectors-notion-sync',
  'insights-generate',
]);

function listFunctions() {
  return readdirSync(FN_DIR).filter((name) => {
    const full = join(FN_DIR, name);
    if (!statSync(full).isDirectory()) return false;
    if (name.startsWith('_')) return false;
    return existsSync(join(full, 'index.ts'));
  });
}

const CLI = process.env.SUPABASE_CLI ?? 'npx -y supabase';

function deploy(name) {
  const noJwt = NO_JWT.has(name) ? '--no-verify-jwt' : '';
  const cmd = `${CLI} functions deploy ${name} ${noJwt}`.trim();
  console.log(`\n→ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : listFunctions();

console.log(`Deploying ${targets.length} function(s) to Supabase…\n`);
for (const name of targets) {
  try {
    deploy(name);
  } catch (e) {
    console.error(`\n× Failed to deploy ${name}: ${e.message}`);
    process.exit(1);
  }
}
console.log('\n✓ All functions deployed.');
