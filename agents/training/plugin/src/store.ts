import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const TRAINING_SCHEMA_VERSION = 1;

const DDL = String.raw`
CREATE TABLE exercises(
  exercise_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT,
  equipment_type TEXT,
  load_mode TEXT NOT NULL CHECK(load_mode IN ('TOTAL_EXTERNAL','PER_HAND','PER_SIDE','ADDED_BODYWEIGHT','ASSISTANCE','MACHINE_DISPLAYED','BODYWEIGHT','NONE')),
  rep_mode TEXT NOT NULL DEFAULT 'TOTAL' CHECK(rep_mode IN ('TOTAL','PER_SIDE')),
  load_progression_direction TEXT NOT NULL CHECK(load_progression_direction IN ('HIGHER_IS_HARDER','LOWER_IS_HARDER','NOT_APPLICABLE')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE exercise_aliases(
  exercise_alias_id TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL REFERENCES exercises(exercise_id) ON DELETE CASCADE,
  alias TEXT NOT NULL COLLATE NOCASE UNIQUE
) STRICT;
CREATE TABLE equipment_instances(
  equipment_instance_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  equipment_type TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE programs(
  program_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  objective TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE program_versions(
  program_version_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(program_id),
  version_number INTEGER NOT NULL CHECK(version_number>0),
  status TEXT NOT NULL CHECK(status IN ('DRAFT','ACTIVE','RETIRED')),
  progression_policy_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL CHECK(created_by IN ('USER','HEALTH_MAIN','MIGRATION')),
  decision_reason TEXT,
  activated_at TEXT,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(program_id,version_number)
) STRICT;
CREATE UNIQUE INDEX ux_program_active ON program_versions(status) WHERE status='ACTIVE';

CREATE TABLE workout_templates(
  workout_template_id TEXT PRIMARY KEY,
  program_version_id TEXT NOT NULL REFERENCES program_versions(program_version_id),
  name TEXT NOT NULL,
  workout_kind TEXT NOT NULL CHECK(workout_kind IN ('STRENGTH','CONDITIONING')),
  notes TEXT,
  UNIQUE(program_version_id,name)
) STRICT;
CREATE TABLE program_slots(
  program_slot_id TEXT PRIMARY KEY,
  program_version_id TEXT NOT NULL REFERENCES program_versions(program_version_id),
  sequence INTEGER NOT NULL CHECK(sequence>0),
  workout_template_id TEXT NOT NULL REFERENCES workout_templates(workout_template_id),
  UNIQUE(program_version_id,sequence)
) STRICT;
CREATE TABLE program_cursor(
  program_version_id TEXT PRIMARY KEY REFERENCES program_versions(program_version_id),
  cycle_number INTEGER NOT NULL DEFAULT 1 CHECK(cycle_number>0),
  next_program_slot_id TEXT NOT NULL REFERENCES program_slots(program_slot_id),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE template_exercises(
  template_exercise_id TEXT PRIMARY KEY,
  workout_template_id TEXT NOT NULL REFERENCES workout_templates(workout_template_id),
  exercise_id TEXT NOT NULL REFERENCES exercises(exercise_id),
  sequence INTEGER NOT NULL CHECK(sequence>0),
  target_sets INTEGER NOT NULL CHECK(target_sets>0),
  target_reps_min INTEGER CHECK(target_reps_min IS NULL OR target_reps_min>=0),
  target_reps_max INTEGER CHECK(target_reps_max IS NULL OR target_reps_max>=0),
  target_rir_min REAL CHECK(target_rir_min IS NULL OR target_rir_min>=0),
  target_rir_max REAL CHECK(target_rir_max IS NULL OR target_rir_max>=0),
  progression_policy_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  UNIQUE(workout_template_id,sequence),
  CHECK(target_reps_min IS NULL OR target_reps_max IS NULL OR target_reps_min<=target_reps_max),
  CHECK(target_rir_min IS NULL OR target_rir_max IS NULL OR target_rir_min<=target_rir_max)
) STRICT;

CREATE TABLE conditioning_modalities(
  modality_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
) STRICT;
CREATE TABLE conditioning_policies(
  conditioning_policy_id TEXT PRIMARY KEY,
  workout_template_id TEXT NOT NULL UNIQUE REFERENCES workout_templates(workout_template_id),
  objective TEXT NOT NULL,
  min_duration_sec INTEGER CHECK(min_duration_sec IS NULL OR min_duration_sec>=0),
  max_duration_sec INTEGER CHECK(max_duration_sec IS NULL OR max_duration_sec>=0),
  intensity_basis TEXT CHECK(intensity_basis IS NULL OR intensity_basis IN ('HR_ZONE','HEART_RATE','RPE','POWER','PACE','MIXED')),
  notes TEXT,
  CHECK(min_duration_sec IS NULL OR max_duration_sec IS NULL OR min_duration_sec<=max_duration_sec)
) STRICT;
CREATE TABLE conditioning_policy_modalities(
  conditioning_policy_id TEXT NOT NULL REFERENCES conditioning_policies(conditioning_policy_id) ON DELETE CASCADE,
  modality_id TEXT NOT NULL REFERENCES conditioning_modalities(modality_id),
  PRIMARY KEY(conditioning_policy_id,modality_id)
) STRICT;

CREATE TABLE training_sessions(
  training_session_id TEXT PRIMARY KEY,
  program_version_id TEXT REFERENCES program_versions(program_version_id),
  workout_template_id TEXT REFERENCES workout_templates(workout_template_id),
  session_kind TEXT NOT NULL CHECK(session_kind IN ('STRENGTH','CONDITIONING')),
  session_source TEXT NOT NULL CHECK(session_source IN ('PROGRAM','AD_HOC','MIGRATION')),
  recommended_program_slot_id TEXT REFERENCES program_slots(program_slot_id),
  selected_program_slot_id TEXT REFERENCES program_slots(program_slot_id),
  selection_source TEXT NOT NULL CHECK(selection_source IN ('PROGRAM_RECOMMENDATION','USER_FORWARD_OVERRIDE','USER_REPEAT','USER_AD_HOC','MIGRATION')),
  cursor_before_slot_id TEXT REFERENCES program_slots(program_slot_id),
  cursor_before_cycle_number INTEGER,
  cursor_on_complete_slot_id TEXT REFERENCES program_slots(program_slot_id),
  cursor_on_complete_cycle_number INTEGER,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','PAUSED','COMPLETED','ABANDONED','VOIDED')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  timezone_at_start TEXT NOT NULL,
  local_date TEXT NOT NULL,
  overall_feedback TEXT,
  created_at TEXT NOT NULL,
  CHECK((status IN ('ACTIVE','PAUSED') AND ended_at IS NULL) OR (status IN ('COMPLETED','ABANDONED','VOIDED') AND ended_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX ux_training_open_session ON training_sessions((1)) WHERE status IN ('ACTIVE','PAUSED');
CREATE TABLE training_session_pauses(
  pause_id TEXT PRIMARY KEY,
  training_session_id TEXT NOT NULL REFERENCES training_sessions(training_session_id) ON DELETE CASCADE,
  paused_at TEXT NOT NULL,
  resumed_at TEXT
) STRICT;
CREATE UNIQUE INDEX ux_training_open_pause ON training_session_pauses(training_session_id) WHERE resumed_at IS NULL;

CREATE TABLE program_slot_outcomes(
  program_slot_outcome_id TEXT PRIMARY KEY,
  program_version_id TEXT NOT NULL REFERENCES program_versions(program_version_id),
  cycle_number INTEGER NOT NULL CHECK(cycle_number>0),
  program_slot_id TEXT NOT NULL REFERENCES program_slots(program_slot_id),
  training_session_id TEXT REFERENCES training_sessions(training_session_id),
  outcome TEXT NOT NULL CHECK(outcome IN ('COMPLETED','COMPLETED_PARTIAL','SKIPPED_FORWARD_OVERRIDE')),
  created_at TEXT NOT NULL,
  UNIQUE(program_version_id,cycle_number,program_slot_id)
) STRICT;

CREATE TABLE session_exercises(
  session_exercise_id TEXT PRIMARY KEY,
  training_session_id TEXT NOT NULL REFERENCES training_sessions(training_session_id) ON DELETE CASCADE,
  template_exercise_id TEXT REFERENCES template_exercises(template_exercise_id),
  exercise_id TEXT NOT NULL REFERENCES exercises(exercise_id),
  substituted_from_exercise_id TEXT REFERENCES exercises(exercise_id),
  equipment_instance_id TEXT REFERENCES equipment_instances(equipment_instance_id),
  sequence INTEGER NOT NULL CHECK(sequence>0),
  planned_sets INTEGER NOT NULL CHECK(planned_sets>0),
  target_reps_min INTEGER CHECK(target_reps_min IS NULL OR target_reps_min>=0),
  target_reps_max INTEGER CHECK(target_reps_max IS NULL OR target_reps_max>=0),
  target_rir_min REAL CHECK(target_rir_min IS NULL OR target_rir_min>=0),
  target_rir_max REAL CHECK(target_rir_max IS NULL OR target_rir_max>=0),
  progression_policy_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN ('PENDING','ACTIVE','DEFERRED','COMPLETED','SKIPPED')),
  CHECK(target_reps_min IS NULL OR target_reps_max IS NULL OR target_reps_min<=target_reps_max),
  CHECK(target_rir_min IS NULL OR target_rir_max IS NULL OR target_rir_min<=target_rir_max),
  adaptation_reason TEXT,
  prescribed_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  notes TEXT,
  UNIQUE(training_session_id,sequence)
) STRICT;
CREATE UNIQUE INDEX ux_training_active_exercise ON session_exercises(training_session_id) WHERE status='ACTIVE';

CREATE TABLE session_sets(
  session_set_id TEXT PRIMARY KEY,
  session_exercise_id TEXT NOT NULL REFERENCES session_exercises(session_exercise_id) ON DELETE CASCADE,
  set_number INTEGER NOT NULL CHECK(set_number>0),
  candidate_reps INTEGER CHECK(candidate_reps IS NULL OR candidate_reps>=0),
  candidate_load_kg REAL CHECK(candidate_load_kg IS NULL OR candidate_load_kg>=0),
  candidate_rir REAL CHECK(candidate_rir IS NULL OR candidate_rir>=0),
  target_reps INTEGER CHECK(target_reps IS NULL OR target_reps>=0),
  target_load_kg REAL CHECK(target_load_kg IS NULL OR target_load_kg>=0),
  target_rir REAL CHECK(target_rir IS NULL OR target_rir>=0),
  prescription_reason TEXT,
  actual_reps INTEGER CHECK(actual_reps IS NULL OR actual_reps>=0),
  actual_load_kg REAL CHECK(actual_load_kg IS NULL OR actual_load_kg>=0),
  actual_rir REAL CHECK(actual_rir IS NULL OR actual_rir>=0),
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK(status IN ('PLANNED','COMPLETED','SKIPPED')),
  notes TEXT,
  UNIQUE(session_exercise_id,set_number)
) STRICT;

CREATE TABLE conditioning_prescriptions(
  conditioning_prescription_id TEXT PRIMARY KEY,
  training_session_id TEXT NOT NULL UNIQUE REFERENCES training_sessions(training_session_id) ON DELETE CASCADE,
  conditioning_policy_id TEXT REFERENCES conditioning_policies(conditioning_policy_id),
  recommended_modality_id TEXT REFERENCES conditioning_modalities(modality_id),
  selected_modality_id TEXT NOT NULL REFERENCES conditioning_modalities(modality_id),
  modality_selection_source TEXT NOT NULL CHECK(modality_selection_source IN ('AGENT_RECOMMENDATION','USER_OVERRIDE','USER_AD_HOC','MIGRATION')),
  protocol_summary TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE conditioning_segments(
  conditioning_segment_id TEXT PRIMARY KEY,
  conditioning_prescription_id TEXT NOT NULL REFERENCES conditioning_prescriptions(conditioning_prescription_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  segment_type TEXT NOT NULL CHECK(segment_type IN ('WARMUP','WORK','RECOVERY','COOLDOWN')),
  target_duration_sec INTEGER CHECK(target_duration_sec IS NULL OR target_duration_sec>=0),
  target_distance_m REAL CHECK(target_distance_m IS NULL OR target_distance_m>=0),
  target_hr_min INTEGER CHECK(target_hr_min IS NULL OR target_hr_min>0),
  target_hr_max INTEGER CHECK(target_hr_max IS NULL OR target_hr_max>0),
  target_hr_zone INTEGER CHECK(target_hr_zone IS NULL OR target_hr_zone BETWEEN 1 AND 5),
  target_power_w REAL CHECK(target_power_w IS NULL OR target_power_w>=0),
  target_cadence REAL CHECK(target_cadence IS NULL OR target_cadence>=0),
  actual_duration_sec INTEGER CHECK(actual_duration_sec IS NULL OR actual_duration_sec>=0),
  actual_distance_m REAL CHECK(actual_distance_m IS NULL OR actual_distance_m>=0),
  actual_avg_hr INTEGER CHECK(actual_avg_hr IS NULL OR actual_avg_hr>0),
  actual_max_hr INTEGER CHECK(actual_max_hr IS NULL OR actual_max_hr>0),
  actual_power_w REAL CHECK(actual_power_w IS NULL OR actual_power_w>=0),
  actual_cadence REAL CHECK(actual_cadence IS NULL OR actual_cadence>=0),
  notes TEXT,
  UNIQUE(conditioning_prescription_id,sequence),
  CHECK(target_hr_min IS NULL OR target_hr_max IS NULL OR target_hr_min<=target_hr_max)
) STRICT;
CREATE TABLE conditioning_results(
  conditioning_prescription_id TEXT PRIMARY KEY REFERENCES conditioning_prescriptions(conditioning_prescription_id) ON DELETE CASCADE,
  actual_duration_sec INTEGER CHECK(actual_duration_sec IS NULL OR actual_duration_sec>=0),
  actual_distance_m REAL CHECK(actual_distance_m IS NULL OR actual_distance_m>=0),
  actual_avg_power_w REAL CHECK(actual_avg_power_w IS NULL OR actual_avg_power_w>=0),
  actual_avg_cadence REAL CHECK(actual_avg_cadence IS NULL OR actual_avg_cadence>=0),
  rpe REAL CHECK(rpe IS NULL OR (rpe>=0 AND rpe<=10)),
  notes TEXT
) STRICT;
CREATE TABLE external_telemetry_links(
  telemetry_link_id TEXT PRIMARY KEY,
  training_session_id TEXT NOT NULL REFERENCES training_sessions(training_session_id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('NONE','PENDING','AVAILABLE','INCOMPLETE','FAILED')),
  external_activity_id TEXT,
  telemetry_started_at TEXT,
  telemetry_ended_at TEXT,
  avg_hr INTEGER,
  max_hr INTEGER,
  time_in_target_zone_sec INTEGER,
  zones_json TEXT NOT NULL DEFAULT '{}',
  data_quality TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(training_session_id,source)
) STRICT;

CREATE TABLE training_feedback(
  feedback_id TEXT PRIMARY KEY,
  training_session_id TEXT NOT NULL REFERENCES training_sessions(training_session_id) ON DELETE CASCADE,
  session_exercise_id TEXT REFERENCES session_exercises(session_exercise_id) ON DELETE SET NULL,
  source_provider TEXT,
  source_chat_id TEXT,
  source_message_id TEXT,
  raw_text TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE observations(
  observation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  statement TEXT NOT NULL,
  structured_value_json TEXT NOT NULL DEFAULT '{}',
  persistence_class TEXT NOT NULL CHECK(persistence_class IN ('SITUATIONAL','POTENTIALLY_PERSISTENT','EXPLICITLY_PERSISTENT')),
  source_type TEXT NOT NULL CHECK(source_type IN ('USER_CHAT','PERFORMANCE','AGENT_ANALYSIS','MIGRATION')),
  source_feedback_id TEXT REFERENCES training_feedback(feedback_id) ON DELETE SET NULL,
  source_session_id TEXT REFERENCES training_sessions(training_session_id) ON DELETE SET NULL,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','RETRACTED')),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE learned_items(
  learned_item_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  statement TEXT NOT NULL,
  value_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN ('HYPOTHESIS','ACTIVE','SUPERSEDED','REJECTED')),
  promotion_basis TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_confirmed_at TEXT
) STRICT;
CREATE TABLE learning_evidence(
  learned_item_id TEXT NOT NULL REFERENCES learned_items(learned_item_id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES observations(observation_id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('SUPPORTS','CONTRADICTS')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(learned_item_id,observation_id)
) STRICT;

CREATE TABLE program_change_proposals(
  proposal_id TEXT PRIMARY KEY,
  base_program_version_id TEXT NOT NULL REFERENCES program_versions(program_version_id),
  created_by TEXT NOT NULL CHECK(created_by IN ('TRAINING_AGENT','USER','HEALTH_MAIN')),
  change_type TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED','APPLIED')),
  decision_actor TEXT CHECK(decision_actor IN ('USER','HEALTH_MAIN')),
  decided_at TEXT,
  applied_program_version_id TEXT REFERENCES program_versions(program_version_id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE data_corrections(
  correction_id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  previous_value_json TEXT NOT NULL,
  corrected_value_json TEXT NOT NULL,
  reason TEXT,
  source_kind TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE training_events(
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_slots_version_sequence ON program_slots(program_version_id,sequence);
CREATE INDEX ix_sessions_started_at ON training_sessions(started_at);
CREATE INDEX ix_session_exercises_order ON session_exercises(training_session_id,sequence);
CREATE INDEX ix_session_sets_order ON session_sets(session_exercise_id,set_number);
CREATE INDEX ix_events_aggregate ON training_events(aggregate_type,aggregate_id,created_at);
`;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function openTrainingStore(databasePath: string): DatabaseSync {
  if (!databasePath || !path.isAbsolute(databasePath)) {
    throw new Error("Training databasePath must be an absolute path");
  }
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(databasePath), 0o700); } catch {}
  const db = new DatabaseSync(databasePath, { timeout: 5000 });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version === 0) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(DDL);
      db.exec(`PRAGMA user_version=${TRAINING_SCHEMA_VERSION}; COMMIT;`);
    } catch (error) {
      try { db.exec("ROLLBACK;"); } catch {}
      throw error;
    }
  } else if (version !== TRAINING_SCHEMA_VERSION) {
    db.close();
    throw new Error(`Unsupported Training schema ${version}; expected ${TRAINING_SCHEMA_VERSION}`);
  }
  try { fs.chmodSync(databasePath, 0o600); } catch {}
  return db;
}

export function withTransaction<T>(db: DatabaseSync, effect: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = effect();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {}
    throw error;
  }
}

export function healthSnapshot(db: DatabaseSync) {
  const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  const schema = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || foreignKeys.length !== 0) {
    throw new Error("Training database integrity check failed");
  }
  return {
    schema_version: schema,
    integrity: "ok",
    foreign_key_violations: 0,
    counts: {
      programs: Number((db.prepare("SELECT count(*) n FROM programs").get() as { n: number }).n),
      sessions: Number((db.prepare("SELECT count(*) n FROM training_sessions").get() as { n: number }).n),
      exercises: Number((db.prepare("SELECT count(*) n FROM exercises").get() as { n: number }).n),
    },
  };
}
