# Training migration

This directory contains the one-time deterministic import boundary for legacy Training data.

## Source boundary

The public repository does not fetch or contain the private Fitness workbook.

Production migration uses two separate steps:

1. export and normalize the private Fitness training tabs outside this public repository;
2. pass the normalized JSON file to this importer.

The importer accepts only `training-normalized-migration-v1`.

It intentionally has no fields for Nutrition Targets or Measures. Those domains do not move into Training merely because they currently share the Fitness workbook.

## Facts, not reconstruction

A normalized export may contain:
- exercise definitions whose semantics are known;
- historical Program Versions/templates/slots when known;
- historical strength working sets;
- historical Conditioning summaries.

It must not invent:
- precise timestamps when only a date exists;
- historical program-slot selection when not recorded;
- historical candidate/target prescriptions when only actual sets are known;
- Fitbit telemetry;
- conversational intent or override reasons.

Date-only sessions are imported with `time_precision=DATE_ONLY`, not fake midnight timestamps.

## Command

Build the plugin first, then run:

```bash
node agents/training/migration/import.mjs \
  /absolute/path/training.sqlite3 \
  /absolute/path/normalized-training.json
```

The importer:
- requires an empty operational Training Store for the first import;
- records migration provenance;
- hashes the exact input file;
- replays the same `source_system + source_export_id + SHA-256` without duplicates;
- fails closed if the same export id is presented with different content.

Real exports are Sensitive and must never be committed.
