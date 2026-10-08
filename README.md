# OpenClaw Agents

Public non-secret implementations for specialized OpenClaw agents and shared OpenClaw extensions.

This source tree is designed to be published as the authoritative implementation repository. Canonical behavior, architecture, authority, lifecycle, private source relationships, and expected runtime state remain in private Nexus. Production-control authorization and runtime evidence remain in private operational state and are not owned by this repository.

Each package under `agents/` owns its reproducible implementation. Cross-agent infrastructure shared by more than one package lives under `shared/`.

## Public / private boundary

This repository may contain reproducible source, tests, synthetic fixtures, generic deployment/recovery implementation, package metadata, approved low-risk personal defaults, and non-sensitive implementation documentation.

It must not contain credentials, production SQLite data, operational Task/Contact data, private Nexus repository identities or content, active production-control bindings, production baselines, detailed runtime diagnostics/evidence, provider-managed private state, or independent production authorization.

GitHub Actions in this repository is a non-production validation/preparation layer only. Workflows must remain read-only by default, use GitHub-hosted runners, receive no production credentials or private Nexus access, and must not publish production runtime evidence.

## Execution policy

Repository-bound build, test, packaging, generated-output verification, synthetic migration validation, and isolated qualification are CI-first work and should normally run in the existing GitHub Actions workflows on GitHub-hosted runners.

A production OpenClaw host is not a development or build workspace. Use it only for operations whose correctness depends on live runtime state, such as production preflight, registered deployment or recovery, migration/reload/restart when authorized, runtime-specific validation, and rollback.

Do not manually run heavy repository preparation such as `npm ci`, package builds, full source qualification, or isolated/deployment test harnesses on a production host when GitHub Actions can provide the same evidence. If source work genuinely needs a local workspace, use an explicitly disposable non-production workspace and remove temporary worktrees, dependency trees, generated build directories, and caches when the work ends.

Detailed executor guidance is in [AGENTS.md](AGENTS.md).

## Runtime compatibility

`runtime-contract.json` is the executable repository-wide Node/runtime implementation contract. The exact candidate OpenClaw host version is owned separately by `openclaw-qualification.json`; `shared/runtime-contract/` validates these inputs and their implementation consumers. Neither file authorizes a production rollout.

These implementation contracts do not replace Nexus authority over intended runtime state. A compatibility-sensitive change must be reconciled with live Nexus and official OpenClaw support documentation before deployment.

### OpenClaw host qualification workflow

The intended operating experience is **one reviewed qualification PR and one separately owner-approved rollout request**, reusing existing GitHub Actions and the registered production controller. A published OpenClaw release or a passing static build is not by itself evidence of host/plugin compatibility.

1. **Preflight before source churn.** Read the official target release and plugin API/migration notes, identify the effective owned-plugin cohort, and inspect the live controller's protected-path and production baselines. If protected drift blocks routine rollout, record it as a separately governed dependency rather than quietly changing protected paths or claiming deployability.
2. **Prepare one exact candidate revision.** In an ordinary implementation PR, pin the target in `openclaw-qualification.json`. Reconcile every affected owned plugin's exact development/build version, `peerDependencies.openclaw`, `openclaw.compat.pluginApi`, release identity, lockfile, and frozen artifact/checksum according to that package's existing release procedure. This includes Taskctl, Contacts, Calendar, Investments, and Training as applicable to the intended runtime cohort. Do not declare compatibility with untested future host versions; retain the previously proven floor only while its coverage remains valid. No production-host build or installation is required for PR preparation.
3. **Use existing CI; do not create a second qualification system.** The relevant Task Agent, production-control, Engineer, Calendar, Investments, and Training workflows must finish successfully on the exact reviewed candidate as applicable. Check that each host-sensitive test used the intended OpenClaw version, not merely the version from a plugin's earlier development lockfile. Task/Contacts isolated-host checks and Training runtime/idempotency tests provide stronger evidence than Calendar/Investments build/manifest validation alone. If a release changes an integration used by the latter plugins, add the smallest relevant runtime-path proof before declaring compatibility.
4. **Promote only evidenced compatibility.** Review the final PR diff, all owned plugin compatibility declarations and release artifacts, the official upstream changes, and any remaining host/runtime-path gaps. The PR/CI result qualifies only the exact source candidate and the tests actually performed. A compatibility-range extension or merge must not be interpreted as automatic production approval.
5. **Roll out through registered authority only.** After accepted source review/merge and resolution of protected-path dependencies, use the existing owner-approved exact-revision production rollout operation. Its live resource, backup, predecessor, Codex-cohort, specialized-agent and recovery gates still apply. Reconcile final live behavior and state from controller evidence rather than inferring success from CI.

This workflow is implemented through existing repository PRs, existing GitHub-hosted CI, and the existing production controller. It authorizes **no automatic PR writes, scheduled upgrade bot, new service, production credentials in CI, protected-control changes, or unattended rollout**.

## Packages

- `agents/tasks/` — Task Agent implementation.
- `agents/engineer/` — Engineer Agent implementation.
- `agents/calendar/` — Calendar Agent implementation.
- `agents/investments/` — Investments Agent implementation.

## Shared infrastructure

- `shared/runtime-contract/` — repository-wide OpenClaw/Node compatibility validation.
- `shared/contacts/` — shared deterministic Contact Registry implementation and its bounded OpenClaw integration.
- `shared/nexus-sync/` — generic read-only Nexus synchronization mechanics; the private remote is supplied externally at runtime.
- `shared/voice-transcription/` — local voice-transcription preprocessing shared by Telegram agents.
- `shared/public-boundary/` — deterministic checks that reject known private-source and credential material before publication.

The deterministic Task production controller is implementation source only. Its concrete private control repository, issue, owner identity, credentials, production baseline, and execution evidence are supplied or retained outside this public source tree.
