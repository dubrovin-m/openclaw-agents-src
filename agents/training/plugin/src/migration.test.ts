import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getProgressionCandidate, startProgramSession } from "./domain.js";
import { importNormalizedTraining, type NormalizedTrainingMigrationV1 } from "./migration.js";
import { openTrainingStore } from "./store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function payload(): NormalizedTrainingMigrationV1 {
  return {
    format: "training-normalized-migration-v1",
    source_system: "fitness-workbook",
    source_export_id: "synthetic-export-1",
    exercises: [
      {
        source_id: "legacy-ex-squat",
        name: "Back Squat",
        category: "strength",
        equipment_type: "barbell",
        load_mode: "TOTAL_EXTERNAL",
        rep_mode: "TOTAL",
        load_progression_direction: "HIGHER_IS_HARDER",
      },
      {
        source_id: "legacy-ex-carry",
        name: "Farmer Carry",
        category: "strength",
        equipment_type: "dumbbell",
        load_mode: "PER_HAND",
        rep_mode: "TOTAL",
        load_progression_direction: "HIGHER_IS_HARDER",
      },
      {
        source_id: "legacy-ex-mobility",
        name: "Ankle rocks",
        category: "mobility",
        equipment_type: null,
        load_mode: "NONE",
        rep_mode: "TOTAL",
        load_progression_direction: "NOT_APPLICABLE",
      },
    ],
    program_versions: [{
      source_id: "legacy-version-active",
      program_source_id: "legacy-program",
      program_name: "Migrated Program",
      objective: "Synthetic migration qualification",
      version_number: 1,
      status: "ACTIVE",
      progression_policy_json: JSON.stringify({ kind: "HOLD_LAST_LOAD" }),
      templates: [
        {
          source_id: "legacy-template-a",
          name: "Strength A",
          workout_kind: "STRENGTH",
          strength_exercises: [{
            source_id: "legacy-template-ex-squat",
            exercise_source_id: "legacy-ex-squat",
            sequence: 1,
            target_sets: 1,
            target_reps_min: 6,
            target_reps_max: 6,
            target_rir_min: 2,
            target_rir_max: 2,
            progression_policy_json: JSON.stringify({ kind: "HOLD_LAST_LOAD" }),
          }],
        },
        {
          source_id: "legacy-template-cond",
          name: "Conditioning",
          workout_kind: "CONDITIONING",
          strength_exercises: [{
            source_id: "legacy-template-ex-mobility",
            exercise_source_id: "legacy-ex-mobility",
            sequence: 1,
            target_sets: 2,
            target_reps_min: 10,
            target_reps_max: 10,
            target_rir_min: null,
            target_rir_max: null,
          }],
          conditioning_policy: {
            source_id: "legacy-cond-policy",
            objective: "Aerobic base",
            min_duration_sec: 1200,
            max_duration_sec: 2400,
            intensity_basis: "HR_ZONE",
            modalities: [{ source_id: "legacy-mod-bike", name: "Bike" }],
          },
        },
      ],
      slots: [
        { source_id: "legacy-slot-a", sequence: 1, template_source_id: "legacy-template-a" },
        { source_id: "legacy-slot-cond", sequence: 2, template_source_id: "legacy-template-cond" },
      ],
    }],
    active_cursor: {
      program_version_source_id: "legacy-version-active",
      next_slot_source_id: "legacy-slot-a",
      cycle_number: 1,
    },
    sessions: [
      {
        source_id: "legacy-session-strength",
        session_kind: "STRENGTH",
        status: "COMPLETED",
        local_date: "2026-09-30",
        strength_exercises: [
          {
            source_id: "legacy-session-ex-squat",
            exercise_source_id: "legacy-ex-squat",
            sequence: 1,
            status: "COMPLETED",
            actual_sets: [{
              source_id: "legacy-set-squat-1",
              set_number: 1,
              status: "COMPLETED",
              actual_reps: 6,
              actual_load_kg: 67.5,
              actual_rir: 2,
            }],
          },
          {
            source_id: "legacy-session-ex-carry",
            exercise_source_id: "legacy-ex-carry",
            sequence: 2,
            status: "COMPLETED",
            actual_sets: [
              {
                source_id: "legacy-set-carry-1",
                set_number: 1,
                status: "COMPLETED",
                actual_reps: null,
                actual_load_kg: 32,
                actual_rir: null,
                actual_distance_m: 40,
              },
              {
                source_id: "legacy-set-carry-2",
                set_number: 2,
                status: "COMPLETED",
                actual_reps: null,
                actual_load_kg: 32,
                actual_rir: null,
              },
            ],
          },
        ],
      },
      {
        source_id: "legacy-session-conditioning",
        session_kind: "CONDITIONING",
        status: "COMPLETED",
        local_date: "2026-10-01",
        strength_exercises: [{
          source_id: "legacy-session-ex-mobility",
          exercise_source_id: "legacy-ex-mobility",
          sequence: 1,
          status: "COMPLETED",
          actual_sets: [{
            source_id: "legacy-set-mobility-1",
            set_number: 1,
            status: "COMPLETED",
            actual_reps: 10,
            actual_load_kg: null,
            actual_rir: null,
          }],
        }],
        conditioning: {
          source_id: "legacy-conditioning-result",
          selected_modality: { source_id: "legacy-mod-bike", name: "Bike" },
          method: "Zone 2",
          actual_duration_sec: 1800,
          actual_avg_hr: 133,
          rpe: 4,
        },
      },
    ],
  };
}

describe("Training normalized migration", () => {
  it("TRA-MIG-001/002/003: preserves facts, date precision, and supports progression", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "training-migration-"));
    roots.push(root);
    const db = openTrainingStore(path.join(root, "training.sqlite3"));
    try {
      const result: any = importNormalizedTraining(db, payload(), "a".repeat(64));
      expect(result.replayed).toBe(false);
      expect(result.counts.training_sessions).toBe(2);
      expect(result.counts.session_sets).toBe(4);
      expect(result.counts.conditioning_results).toBe(1);
      expect(result.counts.external_telemetry_links).toBe(1);
      const conditioningMobility = Number((db.prepare(
        `SELECT count(*) n FROM template_exercises te
          JOIN workout_templates wt ON wt.workout_template_id=te.workout_template_id
         WHERE wt.workout_kind='CONDITIONING'`
      ).get() as any).n);
      expect(conditioningMobility).toBe(1);
      const migratedMobility = db.prepare(
        `SELECT ss.actual_reps,ts.session_kind
           FROM session_sets ss
           JOIN session_exercises se ON se.session_exercise_id=ss.session_exercise_id
           JOIN training_sessions ts ON ts.training_session_id=se.training_session_id
           JOIN exercises e ON e.exercise_id=se.exercise_id
          WHERE e.name='Ankle rocks' AND ts.local_date='2026-10-01'`
      ).get() as any;
      expect(migratedMobility).toEqual({ actual_reps: 10, session_kind: "CONDITIONING" });

      const migrated = db.prepare(
        "SELECT started_at,ended_at,timezone_at_start,local_date,time_precision FROM training_sessions WHERE local_date='2026-09-30'"
      ).get() as any;
      expect(migrated.started_at).toBeNull();
      expect(migrated.ended_at).toBeNull();
      expect(migrated.timezone_at_start).toBeNull();
      expect(migrated.local_date).toBe("2026-09-30");
      expect(migrated.time_precision).toBe("DATE_ONLY");

      const carries = db.prepare(
        `SELECT ss.set_number,ss.actual_reps,ss.actual_load_kg,ss.actual_rir,ss.actual_duration_sec,ss.actual_distance_m
           FROM session_sets ss
           JOIN session_exercises se ON se.session_exercise_id=ss.session_exercise_id
           JOIN exercises e ON e.exercise_id=se.exercise_id
          WHERE e.name='Farmer Carry' ORDER BY ss.set_number`
      ).all() as any[];
      expect(carries).toEqual([
        {
          set_number: 1, actual_reps: null, actual_load_kg: 32, actual_rir: null,
          actual_duration_sec: null, actual_distance_m: 40,
        },
        {
          set_number: 2, actual_reps: null, actual_load_kg: 32, actual_rir: null,
          actual_duration_sec: null, actual_distance_m: null,
        },
      ]);

      const conditioningFacts = db.prepare(
        `SELECT cp.protocol_summary,etl.source,etl.status,etl.avg_hr,etl.data_quality
           FROM conditioning_prescriptions cp
           JOIN training_sessions ts ON ts.training_session_id=cp.training_session_id
           LEFT JOIN external_telemetry_links etl ON etl.training_session_id=ts.training_session_id
          WHERE ts.local_date='2026-10-01'`
      ).get() as any;
      expect(conditioningFacts).toEqual({
        protocol_summary: "Zone 2",
        source: "fitness-workbook",
        status: "AVAILABLE",
        avg_hr: 133,
        data_quality: "AGGREGATE_ONLY",
      });

      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const currentExercise = started.session.exercises[0];
      const candidate = getProgressionCandidate(db, currentExercise.session_exercise_id);
      expect(candidate.candidate_load_kg).toBe(67.5);
      expect(candidate.basis).toBe("HOLD_LAST_COMPARABLE_LOAD");
    } finally {
      db.close();
    }
  });

  it("replays the same normalized export without duplicate rows", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "training-migration-"));
    roots.push(root);
    const db = openTrainingStore(path.join(root, "training.sqlite3"));
    try {
      importNormalizedTraining(db, payload(), "b".repeat(64));
      const replay: any = importNormalizedTraining(db, payload(), "b".repeat(64));
      expect(replay.replayed).toBe(true);
      expect(Number((db.prepare("SELECT count(*) n FROM training_sessions").get() as any).n)).toBe(2);
      expect(Number((db.prepare("SELECT count(*) n FROM migration_batches").get() as any).n)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("fails closed when the same export id is reused with different content hash", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "training-migration-"));
    roots.push(root);
    const db = openTrainingStore(path.join(root, "training.sqlite3"));
    try {
      importNormalizedTraining(db, payload(), "c".repeat(64));
      expect(() => importNormalizedTraining(db, payload(), "d".repeat(64)))
        .toThrow(/already imported with different content/);
    } finally {
      db.close();
    }
  });
});
