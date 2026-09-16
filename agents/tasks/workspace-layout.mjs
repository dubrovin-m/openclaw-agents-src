#!/usr/bin/env node
'use strict';

import fs from 'node:fs';

const LEGACY_LAYOUT = 'legacy-tools-md-v1';
const AGENTS_TOOLS_LAYOUT = 'agents-md-tools-v1';
const LEGACY_FILES = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md'];
const AGENTS_TOOLS_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md'];

export function loadWorkspaceLayout(releasePath) {
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  const layout = release.workspace_layout ?? LEGACY_LAYOUT;
  if (layout !== LEGACY_LAYOUT && layout !== AGENTS_TOOLS_LAYOUT) {
    throw new Error(`unsupported workspace layout: ${layout}`);
  }
  return { layout, release };
}

export function targetWorkspaceFiles(layout) {
  if (layout === AGENTS_TOOLS_LAYOUT) return AGENTS_TOOLS_FILES.slice();
  if (layout === LEGACY_LAYOUT) return LEGACY_FILES.slice();
  throw new Error(`unsupported workspace layout: ${layout}`);
}

export function recoveryFormat(layout, release = {}) {
  if (release.shared_contacts) return 'task-agent-recovery-v3';
  if (layout === AGENTS_TOOLS_LAYOUT) return 'task-agent-recovery-v2';
  if (layout === LEGACY_LAYOUT) return 'task-agent-recovery-v1';
  throw new Error(`unsupported workspace layout: ${layout}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, releasePath] = process.argv.slice(2);
  const { layout, release } = loadWorkspaceLayout(releasePath);
  if (command === 'layout') process.stdout.write(layout);
  else if (command === 'target-files') process.stdout.write(targetWorkspaceFiles(layout).join(' '));
  else if (command === 'recovery-format') process.stdout.write(recoveryFormat(layout, release));
  else process.exit(2);
}
