# Shared Voice Transcription

## Purpose

Provide the reproducible shared local voice-transcription component used by OpenClaw on the personal VPS.

The supported steady state follows the repository-wide OpenClaw version declared in [`runtime-contract.json`](../../runtime-contract.json). Historical `2026.6.34 -> 2026.8.1` convergence machinery is intentionally not retained in the current implementation tree; Git history is the authority for that completed transition.

## Current contract

- OpenClaw: repository-wide version from [`runtime-contract.json`](../../runtime-contract.json) (`2026.8.2` for this generation)
- transcription engine: pinned `whisper.cpp` `whisper-cli`
- model: pinned `ggml-small.bin` with SHA-256 verification
- media configuration: [`config/tools-media-audio.json`](config/tools-media-audio.json)
- scope: Telegram direct chats only
- transcript echo: disabled

Runtime targets:

- binary: `/home/dubrovin/.local/bin/whisper-cli`
- model: `/home/dubrovin/.local/share/whisper.cpp/models/ggml-small.bin`

## Files

- `install.sh` — reproducible clean installation for the supported stock OpenClaw runtime. It derives the required OpenClaw version from the repository runtime contract, validates prerequisites, builds the pinned Whisper revision, verifies the model checksum, backs up OpenClaw configuration, applies the target media configuration, and fails closed rather than overwriting an existing voice installation.
- `validate.sh` — static source validation; with `--runtime`, derives the expected OpenClaw version from the repository runtime contract and validates the installed binary/model, effective media configuration, OpenClaw config validity, and Gateway liveness.
- `config/tools-media-audio.json` — authoritative target `tools.media` fragment.

## Validation

Static source validation:

```bash
bash shared/voice-transcription/validate.sh
```

Runtime validation on the OpenClaw host:

```bash
bash shared/voice-transcription/validate.sh --runtime
```

A successful run prints `VOICE_TRANSCRIPTION_VALIDATION_PASS`.

## Lifecycle

This directory contains only the supported steady-state component. Version-specific predecessor configs, bridge patches, and convergence harnesses belong in Git history once their transition has completed.
