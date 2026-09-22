# OpenClaw Agents

Public non-secret implementations for specialized OpenClaw agents and shared OpenClaw extensions.

This source tree is designed to be published as the authoritative implementation repository. Canonical behavior, architecture, authority, lifecycle, private source relationships, and expected runtime state remain in private Nexus. Production-control authorization and runtime evidence remain in private operational state and are not owned by this repository.

Each package under `agents/` owns its reproducible implementation. Cross-agent infrastructure shared by more than one package lives under `shared/`.

## Public / private boundary

This repository may contain reproducible source, tests, synthetic fixtures, generic deployment/recovery implementation, package metadata, approved low-risk personal defaults, and non-sensitive implementation documentation.

It must not contain credentials, production SQLite data, operational Task/Contact data, private Nexus repository identities or content, active production-control bindings, production baselines, detailed runtime diagnostics/evidence, provider-managed private state, or independent production authorization.

GitHub Actions in this repository is a non-production validation/preparation layer only. Workflows must remain read-only by default, use GitHub-hosted runners, receive no production credentials or private Nexus access, and must not publish production runtime evidence.

## Runtime compatibility

`runtime-contract.json` is the executable repository-wide implementation contract for the OpenClaw and Node generations against which this repository is built, validated, diagnosed, and recovered. `shared/runtime-contract/` owns deterministic validation of that contract and its implementation consumers.

The runtime contract does not replace Nexus authority over intended runtime state. A contract change is compatibility-sensitive implementation work and must remain reconciled with the owning live Nexus runtime baseline and official OpenClaw support documentation before deployment.

## Packages

- `agents/tasks/` — Task Agent implementation.
- `agents/engineer/` — Engineer Agent implementation.\n- `agents/calendar/` — Calendar Agent implementation.

## Shared infrastructure

- `shared/runtime-contract/` — repository-wide OpenClaw/Node compatibility validation.
- `shared/nexus-sync/` — generic read-only Nexus synchronization mechanics; the private remote is supplied externally at runtime.
- `shared/voice-transcription/` — local voice-transcription preprocessing shared by Telegram agents.
- `shared/public-boundary/` — deterministic checks that reject known private-source and credential material before publication.

The deterministic Task production controller is implementation source only. Its concrete private control repository, issue, owner identity, credentials, production baseline, and execution evidence are supplied or retained outside this public source tree.
