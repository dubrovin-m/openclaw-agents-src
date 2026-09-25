#!/usr/bin/env node
'use strict';

import fs from 'node:fs';

const CURRENT_LAYOUT = 'agents-md-tools-v1';
const CURRENT_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md'];
const CURRENT_RECOVERY_FORMAT = 'task-agent-recovery-v4';

export function loadWorkspaceLayout(releasePath) {
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  const layout = release.workspace_layout;
  if (layout !== CURRENT_LAYOUT) {
    throw new Error(`unsupported workspace layout: ${layout ?? 'missing'}`);
  }
  return { layout, release };
}

export function targetWorkspaceFiles(layout) {
  if (layout === CURRENT_LAYOUT) return CURRENT_FILES.slice();
  throw new Error(`unsupported workspace layout: ${layout}`);
}

export function recoveryFormat(layout, release = {}) {
  if (layout !== CURRENT_LAYOUT || !release.shared_contacts) {
    throw new Error('unsupported recovery contract');
  }
  return CURRENT_RECOVERY_FORMAT;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, releasePath] = process.argv.slice(2);
  const { layout, release } = loadWorkspaceLayout(releasePath);
  if (command === 'layout') process.stdout.write(layout);
  else if (command === 'target-files') process.stdout.write(targetWorkspaceFiles(layout).join(' '));
  else if (command === 'recovery-format') process.stdout.write(recoveryFormat(layout, release));
  else process.exit(2);
}
