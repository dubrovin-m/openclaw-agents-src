# Shared Nexus synchronization

Non-secret implementation for read-only Nexus mirrors used by OpenClaw workspaces. Canonical source authority, recovery requirements, and agent behavior remain in the private Nexus source.

## Owned implementation

This package owns the reproducible non-secret mechanics required to maintain the configured Nexus mirrors:

- `nexus-sync.service` refreshes the primary and Task Agent Nexus checkouts with `git pull --ff-only`;
- `nexus-sync.timer` schedules the refresh every five minutes and is enabled as a persistent user timer;
- `install.sh` validates or recreates the configured checkouts after read-only authentication has been provisioned separately, disables the Git push path, installs the user units, performs one sync, and validates the result;
- `validate.sh` provides source-only and effective-runtime checks.

No private repository URL, deploy key, SSH private key, token, credential, Nexus content, or provider-managed secret belongs in this package.

## Runtime paths

- primary checkout: `/home/dubrovin/.openclaw/workspace/nexus`
- Task Agent checkout: `/home/dubrovin/.openclaw/workspace-tasks/nexus`
- user units: `/home/dubrovin/.config/systemd/user/nexus-sync.service` and `nexus-sync.timer`
- branch: `main`

The concrete private read-only Git remote and its authentication path are external operational configuration. Supply the remote only at execution time through `OPENCLAW_NEXUS_REMOTE`. The installer verifies that the configured repository is reachable non-interactively but never creates, reads, copies, or records private key material or authentication configuration.

## Source validation

```bash
bash ./validate.sh --source
```

This is safe in a disposable CI environment and requires no private Nexus repository value.

## Runtime preflight

After the registered read-only authentication path has been restored:

```bash
OPENCLAW_NEXUS_REMOTE='<private-read-only-remote>' bash ./install.sh --preflight
```

Preflight verifies the owner/runtime boundary, required commands, source package, repository read access, and any existing checkout/unit state without changing it.

## Apply / recovery recreation

```bash
OPENCLAW_NEXUS_REMOTE='<private-read-only-remote>' bash ./install.sh --apply
```

Apply is intentionally fail-closed:

1. existing Nexus paths must either be absent or valid clean `main` checkouts of the supplied private repository;
2. existing installed unit files must either be absent or exactly match this implementation package;
3. the remote Git push URL is set to the intentionally unusable `disabled://nexus-read-only` endpoint while the fetch URL remains unchanged;
4. both checkouts are synchronized with fast-forward-only pulls;
5. the exact service and timer files are installed under the user systemd unit directory;
6. systemd is reloaded, the timer is enabled, and one synchronization service run is executed;
7. runtime validation must pass using the same externally supplied remote binding.

The installer never force-resets a checkout, rewrites Nexus history, creates authentication material, or changes OpenClaw agent authority.

If an existing checkout or installed unit differs from the registered boundary, stop and reconcile it through the normal governed change process rather than overwriting it.
