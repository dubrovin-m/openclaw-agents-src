# Repository execution policy

This repository owns reproducible non-secret OpenClaw implementation source. Canonical behavior, architecture, authority, lifecycle, production state, and private source relationships remain with their registered owners outside this repository.

## Execution surfaces

- Repository-bound build, test, package, generated-output verification, synthetic migration validation, and isolated qualification must normally run in the repository's GitHub Actions workflows on GitHub-hosted runners.
- A production OpenClaw host is not a development, build, or general-purpose qualification workspace.
- Production-host execution is limited to work that genuinely depends on live runtime state: bounded inspection, registered deployment or recovery paths, live preflight, migration/reload/restart when authorized, runtime-specific validation, and rollback.
- Do not manually run repository-preparation commands such as `npm ci`, package builds, full source-validation suites, isolated-runtime harnesses, or deployment-test harnesses on a production host when the same evidence can be produced in GitHub Actions.
- If iterative source work needs a local workspace, use an explicitly disposable non-production workspace. Temporary worktrees, dependency trees, generated build directories, and caches are disposable state and must be removed on terminal success, failure, or abandonment unless they are explicitly required recovery artifacts.
- Do not retain reproducible build trees or caches as historical evidence. Preserve evidence through commits, Pull Requests, workflow runs, frozen artifacts, and exact revisions instead.

## Pull Requests and validation

Use the existing workflow for the affected package rather than creating a parallel validation mechanism. Keep Pull Request scope coherent, let GitHub Actions provide repository-level validation evidence, and reserve the production runtime for production-only checks.

Production authorization, runtime credentials, private operational data, and production evidence must not be moved into GitHub Actions or this public repository.
