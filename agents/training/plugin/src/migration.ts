import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newId, nowIso, withTransaction } from "./store.js";

type StrengthTemplateExercise = {
  source_id: string;
  exercise_source_id: string;
  sequence: number;
  target_sets: number;
  target_reps_min?: number | null;
  target_reps_max?: number | null;
  target_rir_min?: number | null;
  target_rir_max?: number | null;
  target_duration_sec?: number | null;
  target_distance_m?: number | null;
  progression_policy_json?: string;
  notes?: string | null;
};

type MigrationTemplate = {
  source_id: string;
  name: string;
  workout_kind: "STRENGTH" | "CONDITIONING";
  notes?: string | null;
  strength_exercises?: StrengthTemplateExercise[];
  conditioning_policy?: {
    source_id: string;
    objective: string;
    min_duration_sec?: number | null;
    max_duration_sec?: number | null;
    intensity_basis?: "HR_ZONE" | "HEART_RATE" | "RPE" | "POWER" | "PACE" | "MIXED" | null;
    notes?: string | null;
    modalities: Array<{ source_id: string; name: string }>;
  };
};

export type NormalizedTrainingMigrationV1 = {
  format: "training-normalized-migration-v1";
  source_system: string;
  source_export_id: string;
  exported_at?: string;
  exercises: Array<{
    source_id: string;
    name: string;
    category?: string | null;
    equipment_type?: string | null;
    load_mode:
      | "TOTAL_EXTERNAL"
      | "PER_HAND"
      | "PER_SIDE"
      | "ADDED_BODYWEIGHT"
      | "ASSISTANCE"
      | "MACHINE_DISPLAYED"
      | "BODYWEIGHT"
      | "NONE"
      | "LEGACY_SOURCE_RECORDED";
    active?: boolean;
    rep_mode: "TOTAL" | "PER_SIDE";
    load_progression_direction: "HIGHER_IS_HARDER" | "LOWER_IS_HARDER" | "NOT_APPLICABLE";
  }>;
  program_versions: Array<{
    source_id: string;
    program_source_id: string;
    program_name: string;
    objective?: string | null;
    version_number: number;
    status: "ACTIVE" | "RETIRED";
    progression_policy_json?: string;
    decision_reason?: string | null;
    activated_at?: string | null;
    retired_at?: string | null;
    templates: MigrationTemplate[];
    slots: Array<{
      source_id: string;
      sequence: number;
      template_source_id: string;
    }>;
  }>;
  active_cursor?: {
    program_version_source_id: string;
    next_slot_source_id: string;
    cycle_number: number;
  } | null;
  sessions: Array<{
    source_id: string;
    program_version_source_id?: string | null;
    workout_template_source_id?: string | null;
    selected_slot_source_id?: string | null;
    session_kind: "STRENGTH" | "CONDITIONING";
    status: "COMPLETED" | "ABANDONED" | "VOIDED";
    local_date: string;
    started_at?: string | null;
    ended_at?: string | null;
    timezone_at_start?: string | null;
    overall_feedback?: string | null;
    strength_exercises?: Array<{
      source_id: string;
      exercise_source_id: string;
      sequence: number;
      status: "COMPLETED" | "SKIPPED";
      actual_sets: Array<{
        source_id: string;
        set_number: number;
        status: "COMPLETED" | "SKIPPED";
        actual_reps?: number | null;
        actual_load_kg?: number | null;
        actual_rir?: number | null;
        actual_duration_sec?: number | null;
        actual_distance_m?: number | null;
        notes?: string | null;
      }>;
      notes?: string | null;
    }>;
    conditioning?: {
      source_id: string;
      selected_modality: { source_id: string; name: string };
      method?: string | null;
      actual_duration_sec?: number | null;
      actual_distance_m?: number | null;
      actual_avg_hr?: number | null;
      actual_avg_power_w?: number | null;
      actual_avg_cadence?: number | null;
      rpe?: number | null;
      notes?: string | null;
    };
  }>;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing or invalid ${field}`);
  }
  return value.trim();
}

function positiveInt(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`Invalid ${field}`);
  }
  return Number(value);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function nullablePositiveNumber(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function validateJsonObject(raw: string | undefined, field: string): string {
  const value = raw ?? "{}";
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return JSON.stringify(parsed);
}

function mapUnique<T>(map: Map<string, T>, sourceId: string, value: T, type: string): void {
  if (map.has(sourceId)) throw new Error(`Duplicate ${type} source_id: ${sourceId}`);
  map.set(sourceId, value);
}

function count(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n:number }).n);
}

export function importNormalizedTraining(
  db: DatabaseSync,
  payload: NormalizedTrainingMigrationV1,
  inputSha256: string,
) {
  if (payload?.format !== "training-normalized-migration-v1") {
    throw new Error("Unsupported Training migration format");
  }
  const sourceSystem = requiredString(payload.source_system, "source_system");
  const exportId = requiredString(payload.source_export_id, "source_export_id");
  if (!/^[a-f0-9]{64}$/i.test(inputSha256)) throw new Error("Invalid migration input SHA-256");
  if (!Array.isArray(payload.exercises) || !Array.isArray(payload.program_versions) || !Array.isArray(payload.sessions)) {
    throw new Error("Migration collections are missing");
  }

  return withTransaction(db, () => {
    const prior = db.prepare(
      "SELECT input_sha256,result_json FROM migration_batches WHERE source_system=? AND source_export_id=?"
    ).get(sourceSystem, exportId) as { input_sha256:string; result_json:string } | undefined;
    if (prior) {
      if (prior.input_sha256 !== inputSha256) {
        throw new Error("Migration export id was already imported with different content");
      }
      return { replayed: true, ...JSON.parse(prior.result_json) as Record<string, unknown> };
    }

    for (const table of ["programs","program_versions","training_sessions","exercises"]) {
      if (count(db, table) !== 0) {
        throw new Error("Normalized Training migration requires an empty operational store");
      }
    }

    const now = nowIso();
    const batchId = newId("mig");
    db.prepare(
      "INSERT INTO migration_batches(migration_batch_id,source_system,source_export_id,input_sha256,imported_at,result_json) VALUES(?,?,?,?,?,'{}')"
    ).run(batchId, sourceSystem, exportId, inputSha256, now);

    const record = db.prepare(
      "INSERT INTO migration_records(migration_batch_id,source_record_type,source_record_id,target_type,target_id) VALUES(?,?,?,?,?)"
    );
    const recordSource = (sourceType: string, sourceId: string, targetType: string, targetId: string) => {
      record.run(batchId, sourceType, requiredString(sourceId, `${sourceType}.source_id`), targetType, targetId);
    };

    const exerciseMap = new Map<string,string>();
    for (const item of payload.exercises) {
      const sourceId = requiredString(item.source_id, "exercise.source_id");
      const targetId = newId("ex");
      mapUnique(exerciseMap, sourceId, targetId, "exercise");
      const active = item.active === false ? 0 : 1;
      if (item.load_mode === "LEGACY_SOURCE_RECORDED" && (active !== 0 || item.load_progression_direction !== "NOT_APPLICABLE")) {
        throw new Error("LEGACY_SOURCE_RECORDED exercise must be inactive and non-progressing");
      }
      db.prepare(`INSERT INTO exercises(
        exercise_id,name,category,equipment_type,load_mode,rep_mode,load_progression_direction,active,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        targetId,
        requiredString(item.name, "exercise.name"),
        item.category ?? null,
        item.equipment_type ?? null,
        item.load_mode,
        item.rep_mode,
        item.load_progression_direction,
        active,
        now
      );
      recordSource("exercise", sourceId, "exercise", targetId);
    }

    const programMap = new Map<string,string>();
    const versionMap = new Map<string,string>();
    const templateMap = new Map<string,string>();
    const slotMap = new Map<string,string>();
    const policyMap = new Map<string,string>();
    const modalityMap = new Map<string,string>();

    const ensureModality = (sourceIdRaw: string, nameRaw: string): string => {
      const sourceId = requiredString(sourceIdRaw, "modality.source_id");
      const existing = modalityMap.get(sourceId);
      if (existing) return existing;
      const name = requiredString(nameRaw, "modality.name");
      const byName = db.prepare(
        "SELECT modality_id FROM conditioning_modalities WHERE name=?"
      ).get(name) as { modality_id:string } | undefined;
      const targetId = byName?.modality_id ?? newId("mod");
      if (!byName) {
        db.prepare("INSERT INTO conditioning_modalities VALUES(?,?,1)").run(targetId, name);
      }
      mapUnique(modalityMap, sourceId, targetId, "modality");
      recordSource("modality", sourceId, "conditioning_modality", targetId);
      return targetId;
    };

    let activeVersionSourceId: string | null = null;
    for (const version of payload.program_versions) {
      const versionSourceId = requiredString(version.source_id, "program_version.source_id");
      const programSourceId = requiredString(version.program_source_id, "program_source_id");
      let programId = programMap.get(programSourceId);
      if (!programId) {
        programId = newId("prog");
        programMap.set(programSourceId, programId);
        db.prepare("INSERT INTO programs VALUES(?,?,?,?)").run(
          programId,
          requiredString(version.program_name, "program_name"),
          version.objective ?? null,
          now
        );
        recordSource("program", programSourceId, "program", programId);
      }

      const versionId = newId("ver");
      mapUnique(versionMap, versionSourceId, versionId, "program version");
      if (version.status === "ACTIVE") {
        if (activeVersionSourceId) throw new Error("Migration contains more than one ACTIVE Program Version");
        activeVersionSourceId = versionSourceId;
      }
      db.prepare(`INSERT INTO program_versions(
        program_version_id,program_id,version_number,status,progression_policy_json,created_by,
        decision_reason,activated_at,retired_at,created_at
      ) VALUES(?,?,?,?,?,'MIGRATION',?,?,?,?)`).run(
        versionId,
        programId,
        positiveInt(version.version_number, "version_number"),
        version.status,
        validateJsonObject(version.progression_policy_json, "progression_policy_json"),
        version.decision_reason ?? "Migrated from legacy Fitness source",
        version.activated_at ?? null,
        version.retired_at ?? null,
        now
      );
      recordSource("program_version", versionSourceId, "program_version", versionId);

      for (const template of version.templates ?? []) {
        const templateSourceId = requiredString(template.source_id, "template.source_id");
        const templateId = newId("tpl");
        mapUnique(templateMap, templateSourceId, templateId, "workout template");
        db.prepare("INSERT INTO workout_templates VALUES(?,?,?,?,?)").run(
          templateId, versionId, requiredString(template.name, "template.name"),
          template.workout_kind, template.notes ?? null
        );
        recordSource("workout_template", templateSourceId, "workout_template", templateId);

        for (const exercise of template.strength_exercises ?? []) {
          const exerciseId = exerciseMap.get(requiredString(exercise.exercise_source_id, "template exercise exercise_source_id"));
          if (!exerciseId) throw new Error("Template exercise references unknown migrated exercise");
          const exerciseState = db.prepare("SELECT active FROM exercises WHERE exercise_id=?").get(exerciseId) as { active:number } | undefined;
          if (!exerciseState || exerciseState.active !== 1) {
            throw new Error("Program template cannot reference an inactive migrated exercise");
          }
          const targetId = newId("te");
          db.prepare(`INSERT INTO template_exercises(
            template_exercise_id,workout_template_id,exercise_id,sequence,target_sets,
            target_reps_min,target_reps_max,target_rir_min,target_rir_max,target_duration_sec,target_distance_m,
            progression_policy_json,notes
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            targetId, templateId, exerciseId,
            positiveInt(exercise.sequence, "template exercise sequence"),
            positiveInt(exercise.target_sets, "template exercise target_sets"),
            nullableNumber(exercise.target_reps_min, "target_reps_min"),
            nullableNumber(exercise.target_reps_max, "target_reps_max"),
            nullableNumber(exercise.target_rir_min, "target_rir_min"),
            nullableNumber(exercise.target_rir_max, "target_rir_max"),
            nullablePositiveNumber(exercise.target_duration_sec, "target_duration_sec"),
            nullablePositiveNumber(exercise.target_distance_m, "target_distance_m"),
            validateJsonObject(exercise.progression_policy_json, "exercise progression_policy_json"),
            exercise.notes ?? null
          );
          recordSource("template_exercise", exercise.source_id, "template_exercise", targetId);
        }
        if (template.workout_kind === "CONDITIONING") {
          const cp = template.conditioning_policy;
          if (!cp) throw new Error("Conditioning template requires a normalized policy");
          const policyId = newId("cp");
          mapUnique(policyMap, requiredString(cp.source_id, "conditioning_policy.source_id"), policyId, "conditioning policy");
          db.prepare(`INSERT INTO conditioning_policies(
            conditioning_policy_id,workout_template_id,objective,min_duration_sec,max_duration_sec,intensity_basis,notes
          ) VALUES(?,?,?,?,?,?,?)`).run(
            policyId, templateId, requiredString(cp.objective, "conditioning_policy.objective"),
            nullableNumber(cp.min_duration_sec, "min_duration_sec"),
            nullableNumber(cp.max_duration_sec, "max_duration_sec"),
            cp.intensity_basis ?? null, cp.notes ?? null
          );
          recordSource("conditioning_policy", cp.source_id, "conditioning_policy", policyId);
          if (!Array.isArray(cp.modalities) || cp.modalities.length === 0) {
            throw new Error("Conditioning policy requires at least one modality");
          }
          for (const modality of cp.modalities) {
            const modalityId = ensureModality(modality.source_id, modality.name);
            db.prepare("INSERT INTO conditioning_policy_modalities VALUES(?,?)")
              .run(policyId, modalityId);
          }
        }
      }

      for (const slot of version.slots ?? []) {
        const templateId = templateMap.get(requiredString(slot.template_source_id, "slot.template_source_id"));
        if (!templateId) throw new Error("Program slot references unknown template");
        const targetId = newId("slot");
        mapUnique(slotMap, requiredString(slot.source_id, "slot.source_id"), targetId, "program slot");
        db.prepare("INSERT INTO program_slots VALUES(?,?,?,?)").run(
          targetId, versionId, positiveInt(slot.sequence, "slot.sequence"), templateId
        );
        recordSource("program_slot", slot.source_id, "program_slot", targetId);
      }
    }

    if (activeVersionSourceId) {
      const cursor = payload.active_cursor;
      if (!cursor) throw new Error("ACTIVE migrated Program Version requires explicit active_cursor");
      if (cursor.program_version_source_id !== activeVersionSourceId) {
        throw new Error("active_cursor does not reference the ACTIVE Program Version");
      }
      const versionId = versionMap.get(cursor.program_version_source_id);
      const slotId = slotMap.get(cursor.next_slot_source_id);
      if (!versionId || !slotId) throw new Error("active_cursor references an unknown migrated id");
      const slot = db.prepare(
        `SELECT ps.sequence,wt.name
           FROM program_slots ps JOIN workout_templates wt ON wt.workout_template_id=ps.workout_template_id
          WHERE ps.program_slot_id=? AND ps.program_version_id=?`
      ).get(slotId, versionId) as { sequence:number; name:string } | undefined;
      if (!slot || slot.sequence !== 1 || slot.name !== "Strength A") {
        throw new Error("Migrated active Program Version must start at Strength A");
      }
      db.prepare("INSERT INTO program_cursor VALUES(?,?,?,?)").run(
        versionId, positiveInt(cursor.cycle_number, "active_cursor.cycle_number"), slotId, now
      );
    } else if (payload.active_cursor) {
      throw new Error("active_cursor exists without an ACTIVE Program Version");
    }

    for (const session of payload.sessions) {
      const sourceId = requiredString(session.source_id, "session.source_id");
      const sessionId = newId("sess");
      const programVersionId = session.program_version_source_id
        ? versionMap.get(session.program_version_source_id) ?? null
        : null;
      if (session.program_version_source_id && !programVersionId) {
        throw new Error("Session references unknown Program Version");
      }
      const templateId = session.workout_template_source_id
        ? templateMap.get(session.workout_template_source_id) ?? null
        : null;
      if (session.workout_template_source_id && !templateId) {
        throw new Error("Session references unknown workout template");
      }
      const selectedSlotId = session.selected_slot_source_id
        ? slotMap.get(session.selected_slot_source_id) ?? null
        : null;
      if (session.selected_slot_source_id && !selectedSlotId) {
        throw new Error("Session references unknown program slot");
      }
      const localDate = requiredString(session.local_date, "session.local_date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error("Invalid session.local_date");
      const startedAt = session.started_at ?? null;
      const endedAt = session.ended_at ?? null;
      const timePrecision = startedAt ? "EXACT" : "DATE_ONLY";
      if (startedAt && !session.timezone_at_start) {
        throw new Error("Exact migrated session time requires timezone_at_start");
      }

      db.prepare(`INSERT INTO training_sessions(
        training_session_id,program_version_id,workout_template_id,session_kind,session_source,
        recommended_program_slot_id,selected_program_slot_id,selection_source,
        cursor_before_slot_id,cursor_before_cycle_number,cursor_on_complete_slot_id,cursor_on_complete_cycle_number,
        status,started_at,ended_at,timezone_at_start,local_date,time_precision,overall_feedback,created_at
      ) VALUES(?,?,?,?, 'MIGRATION',NULL,?,'MIGRATION',NULL,NULL,NULL,NULL,?,?,?,?,?,?,?,?)`).run(
        sessionId, programVersionId, templateId, session.session_kind,
        selectedSlotId,
        session.status, startedAt, endedAt, session.timezone_at_start ?? null,
        localDate, timePrecision, session.overall_feedback ?? null, now
      );
      recordSource("training_session", sourceId, "training_session", sessionId);

      for (const exercise of session.strength_exercises ?? []) {
        const exerciseId = exerciseMap.get(requiredString(exercise.exercise_source_id, "session exercise exercise_source_id"));
        if (!exerciseId) throw new Error("Session exercise references unknown migrated exercise");
        const sessionExerciseId = newId("sex");
        db.prepare(`INSERT INTO session_exercises(
          session_exercise_id,training_session_id,template_exercise_id,exercise_id,sequence,
          planned_sets,target_reps_min,target_reps_max,target_rir_min,target_rir_max,target_duration_sec,target_distance_m,
          progression_policy_json,status,completed_at,notes
        ) VALUES(?,?,NULL,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'{}',?,?,?)`).run(
          sessionExerciseId, sessionId, exerciseId,
          positiveInt(exercise.sequence, "session exercise sequence"),
          exercise.status,
          endedAt,
          exercise.notes ?? null
        );
        recordSource("session_exercise", exercise.source_id, "session_exercise", sessionExerciseId);

        for (const set of exercise.actual_sets ?? []) {
          const setId = newId("set");
          const status = set.status;
          const reps = status === "SKIPPED" ? null : nullableNumber(set.actual_reps, "actual_reps");
          const load = status === "SKIPPED" ? null : nullableNumber(set.actual_load_kg, "actual_load_kg");
          const rir = status === "SKIPPED" ? null : nullableNumber(set.actual_rir, "actual_rir");
          const duration = status === "SKIPPED" ? null : nullablePositiveNumber(set.actual_duration_sec, "actual_duration_sec");
          const distance = status === "SKIPPED" ? null : nullablePositiveNumber(set.actual_distance_m, "actual_distance_m");
          if (status === "COMPLETED" && reps == null && load == null && duration == null && distance == null) {
            throw new Error("Completed migrated set requires reps, load, duration, or distance");
          }
          db.prepare(`INSERT INTO session_sets(
            session_set_id,session_exercise_id,set_number,
            candidate_reps,candidate_load_kg,candidate_rir,candidate_duration_sec,candidate_distance_m,
            target_reps,target_load_kg,target_rir,target_duration_sec,target_distance_m,prescription_reason,
            actual_reps,actual_load_kg,actual_rir,actual_duration_sec,actual_distance_m,status,notes
          ) VALUES(?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?,?,?,?,?,?)`).run(
            setId, sessionExerciseId, positiveInt(set.set_number, "set_number"),
            reps, load, rir, duration, distance, status, set.notes ?? null
          );
          recordSource("session_set", set.source_id, "session_set", setId);
        }
      }

      if (session.session_kind === "CONDITIONING") {
        const conditioning = session.conditioning;
        if (!conditioning) throw new Error("Migrated Conditioning session requires normalized Conditioning facts");
        const modalityId = ensureModality(
          conditioning.selected_modality.source_id,
          conditioning.selected_modality.name
        );
        let policyId: string | null = null;
        if (templateId) {
          const policy = db.prepare(
            "SELECT conditioning_policy_id FROM conditioning_policies WHERE workout_template_id=?"
          ).get(templateId) as { conditioning_policy_id:string } | undefined;
          policyId = policy?.conditioning_policy_id ?? null;
        }
        const prescriptionId = newId("cond");
        const method = conditioning.method == null ? null : requiredString(conditioning.method, "conditioning.method");
        db.prepare(`INSERT INTO conditioning_prescriptions(
          conditioning_prescription_id,training_session_id,conditioning_policy_id,
          recommended_modality_id,selected_modality_id,modality_selection_source,protocol_summary,created_at
        ) VALUES(?,?,?,NULL,?,'MIGRATION',?,?)`).run(
          prescriptionId, sessionId, policyId, modalityId, method, now
        );
        db.prepare(`INSERT INTO conditioning_results(
          conditioning_prescription_id,actual_duration_sec,actual_distance_m,
          actual_avg_power_w,actual_avg_cadence,rpe,notes
        ) VALUES(?,?,?,?,?,?,?)`).run(
          prescriptionId,
          nullableNumber(conditioning.actual_duration_sec, "conditioning.actual_duration_sec"),
          nullableNumber(conditioning.actual_distance_m, "conditioning.actual_distance_m"),
          nullableNumber(conditioning.actual_avg_power_w, "conditioning.actual_avg_power_w"),
          nullableNumber(conditioning.actual_avg_cadence, "conditioning.actual_avg_cadence"),
          nullableNumber(conditioning.rpe, "conditioning.rpe"),
          conditioning.notes ?? null
        );
        const avgHr = nullableNumber(conditioning.actual_avg_hr, "conditioning.actual_avg_hr");
        if (avgHr !== null) {
          if (!Number.isInteger(avgHr) || avgHr <= 0) throw new Error("Invalid conditioning.actual_avg_hr");
          db.prepare(`INSERT INTO external_telemetry_links(
            telemetry_link_id,training_session_id,source,status,external_activity_id,
            telemetry_started_at,telemetry_ended_at,avg_hr,max_hr,time_in_target_zone_sec,zones_json,data_quality,updated_at
          ) VALUES(?,?,?,'AVAILABLE',NULL,NULL,NULL,?,NULL,NULL,'{}','AGGREGATE_ONLY',?)`).run(
            newId("tel"), sessionId, sourceSystem, avgHr, now
          );
        }
        recordSource("conditioning_session", conditioning.source_id, "conditioning_prescription", prescriptionId);
      }
    }

    const result = {
      migration_batch_id: batchId,
      source_system: sourceSystem,
      source_export_id: exportId,
      counts: {
        exercises: count(db, "exercises"),
        programs: count(db, "programs"),
        program_versions: count(db, "program_versions"),
        workout_templates: count(db, "workout_templates"),
        program_slots: count(db, "program_slots"),
        training_sessions: count(db, "training_sessions"),
        session_exercises: count(db, "session_exercises"),
        session_sets: count(db, "session_sets"),
        conditioning_results: count(db, "conditioning_results"),
        external_telemetry_links: count(db, "external_telemetry_links"),
      },
    };
    db.prepare("UPDATE migration_batches SET result_json=? WHERE migration_batch_id=?")
      .run(JSON.stringify(result), batchId);
    db.prepare("INSERT INTO training_events VALUES(?,?,?,?,?,?)").run(
      newId("evt"), "MIGRATION_IMPORTED", "migration_batch", batchId,
      JSON.stringify({ source_system: sourceSystem, source_export_id: exportId, counts: result.counts }),
      now
    );
    return { replayed: false, ...result };
  });
}
