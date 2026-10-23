import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { after } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-source-checkout-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPC_STATE_DIR = path.join(tmp, 'controller-state');
fs.mkdirSync(process.env.OPC_STATE_DIR, { recursive: true });
const { prepareGitSourceCheckout } = await import(`../controller.mjs?checkout-test=${Date.now()}`);
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'], ...opts }).trim();

test('production source preparation unshallows existing checkout and retains predecessor history', () => {
  const origin = path.join(tmp, 'origin.git');
  const author = path.join(tmp, 'author');
  const checkout = path.join(tmp, 'checkout');
  git(['init', '--bare', origin]);
  fs.mkdirSync(author);
  git(['init', '-b', 'main'], { cwd: author });
  git(['config', 'user.email', 'test@example.invalid'], { cwd: author });
  git(['config', 'user.name', 'test'], { cwd: author });
  fs.writeFileSync(path.join(author, 'predecessor.txt'), 'predecessor\n');
  git(['add', '.'], { cwd: author });
  git(['commit', '-m', 'predecessor'], { cwd: author });
  const predecessor = git(['rev-parse', 'HEAD'], { cwd: author });
  fs.writeFileSync(path.join(author, 'target.txt'), 'target\n');
  git(['add', '.'], { cwd: author });
  git(['commit', '-m', 'target'], { cwd: author });
  const target = git(['rev-parse', 'HEAD'], { cwd: author });
  git(['remote', 'add', 'origin', origin], { cwd: author });
  git(['push', '-u', 'origin', 'main'], { cwd: author });
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: origin });
  git(['clone', '--depth=1', `file://${origin}`, checkout]);
  assert.equal(git(['rev-parse', '--is-shallow-repository'], { cwd: checkout }), 'true');
  assert.throws(() => git(['cat-file', '-e', `${predecessor}^{commit}`], { cwd: checkout }));
  prepareGitSourceCheckout({ targetSha: target, checkoutDir: checkout, repoUrl: `file://${origin}`, token: 'synthetic-token' });
  assert.equal(git(['rev-parse', 'HEAD'], { cwd: checkout }), target);
  assert.equal(git(['rev-parse', '--is-shallow-repository'], { cwd: checkout }), 'false');
  assert.equal(git(['show', `${predecessor}:predecessor.txt`], { cwd: checkout }), 'predecessor');

  // A later main push must not invalidate an already accepted immutable revision.
  git(['commit', '--allow-empty', '-m', 'main advanced'], { cwd: author });
  const advancedMain = git(['rev-parse', 'HEAD'], { cwd: author });
  git(['push', 'origin', 'main'], { cwd: author });
  assert.notEqual(advancedMain, target);
  assert.throws(() => prepareGitSourceCheckout({
    targetSha: target, checkoutDir: checkout, repoUrl: `file://${origin}`, token: 'synthetic-token',
  }), /does not equal requested/u);
  assert.equal(git(['rev-parse', 'HEAD'], { cwd: checkout }), target);

  prepareGitSourceCheckout({
    targetSha: target, checkoutDir: checkout, repoUrl: `file://${origin}`,
    token: 'synthetic-token', requireCurrentMain: false,
  });
  assert.equal(git(['rev-parse', 'HEAD'], { cwd: checkout }), target);
  assert.equal(git(['status', '--porcelain'], { cwd: checkout }), '');
  assert.throws(() => prepareGitSourceCheckout({
    targetSha: 'f'.repeat(40), checkoutDir: checkout, repoUrl: `file://${origin}`,
    token: 'synthetic-token', requireCurrentMain: false,
  }));
  assert.throws(() => prepareGitSourceCheckout({
    targetSha: 'not-a-sha', checkoutDir: checkout, repoUrl: `file://${origin}`,
    token: 'synthetic-token', requireCurrentMain: false,
  }), /target SHA invalid/u);

  // A cached commit on an unrelated branch does not inherit approved-main provenance.
  git(['checkout', '-b', 'unrelated', predecessor], { cwd: author });
  git(['commit', '--allow-empty', '-m', 'unrelated commit'], { cwd: author });
  const unrelated = git(['rev-parse', 'HEAD'], { cwd: author });
  git(['push', 'origin', 'unrelated'], { cwd: author });
  git(['checkout', 'main'], { cwd: author });
  git(['fetch', 'origin', 'refs/heads/unrelated'], { cwd: checkout });
  assert.throws(() => prepareGitSourceCheckout({
    targetSha: unrelated, checkoutDir: checkout, repoUrl: `file://${origin}`,
    token: 'synthetic-token', requireCurrentMain: false,
  }), /not an ancestor/u);
  assert.equal(git(['rev-parse', 'HEAD'], { cwd: checkout }), target);
});
