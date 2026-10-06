import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newId, nowIso, withTransaction } from "./store.js";

type Row = Record<string, SQLInputValue>;

function one<T extends Row>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
function all<T extends Row>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function getOpenSession(db: DatabaseSync) {
  return one(db, "SELECT * FROM training_sessions WHERE status IN ('ACTIVE','PAUSED') LIMIT 1");
}

export function getRecommendation(db: DatabaseSync) {
  const active = one<{program_version_id:string; program_id:string; version_number:number}>(
    db,
    "SELECT program_version_id,program_id,version_number FROM program_versions WHERE status='ACTIVE'"
  );
  if (!active) return { active_program: null, recommendation: null };

  const cursor = one<{next_program_slot_id:string; cycle_number:number}>(
    db,
    "SELECT next_program_slot_id,cycle_number FROM program_cursor WHERE program_version_id=?",
    active.program_version_id
  );
  if (!cursor) throw new Error("Active program is missing a cursor");

  const slot = one<{program_slot_id:string; sequence:number; workout_template_id:string; name:string; workout_kind:string}>(
    db,
    `SELECT ps.program_slot_id,ps.sequence,ps.workout_template_id,wt.name,wt.workout_kind
       FROM program_slots ps JOIN workout_templates wt ON wt.workout_template_id=ps.workout_template_id
      WHERE ps.program_slot_id=? AND ps.program_version_id=?`,
    cursor.next_program_slot_id, active.program_version_id
  );
  if (!slot) throw new Error("Program cursor references an invalid slot");

  const exercises = slot.workout_kind === "STRENGTH" ? all(
    db,
    `SELECT te.template_exercise_id,te.sequence,e.exercise_id,e.name,e.load_mode,e.rep_mode,
            e.load_progression_direction,te.target_sets,te.target_reps_min,te.target_reps_max,
            te.target_rir_min,te.target_rir_max
       FROM template_exercises te JOIN exercises e ON e.exercise_id=te.exercise_id
      WHERE te.workout_template_id=? ORDER BY te.sequence`,
    slot.workout_template_id
  ) : [];

  const conditioningPolicy = slot.workout_kind === "CONDITIONING" ? one(
    db,
    "SELECT * FROM conditioning_policies WHERE workout_template_id=?",
    slot.workout_template_id
  ) : undefined;
  const conditioning = conditioningPolicy
    ? {
        ...conditioningPolicy,
        modalities: all(
          db,
          `SELECT cm.modality_id,cm.name
             FROM conditioning_policy_modalities cpm
             JOIN conditioning_modalities cm ON cm.modality_id=cpm.modality_id
            WHERE cpm.conditioning_policy_id=? AND cm.active=1
            ORDER BY cm.name`,
          conditioningPolicy.conditioning_policy_id
        ),
      }
    : null;

  return {
    active_program: { ...active, cycle_number: cursor.cycle_number },
    recommendation: { ...slot, exercises, conditioning },
  };
}

export function getProgramState(db: DatabaseSync) {
  const active = one<{program_version_id:string; program_id:string; version_number:number}>(
    db,
    "SELECT program_version_id,program_id,version_number FROM program_versions WHERE status='ACTIVE'"
  );
  if (!active) return { active_program: null, cursor: null, slots: [] };
  const cursor = one<{next_program_slot_id:string; cycle_number:number}>(
    db,
    "SELECT next_program_slot_id,cycle_number FROM program_cursor WHERE program_version_id=?",
    active.program_version_id
  );
  if (!cursor) throw new Error("Active program is missing a cursor");

  const slots = all<{
    program_slot_id:string;
    sequence:number;
    workout_template_id:string;
    name:string;
    workout_kind:string;
  }>(
    db,
    `SELECT ps.program_slot_id,ps.sequence,ps.workout_template_id,wt.name,wt.workout_kind
       FROM program_slots ps
       JOIN workout_templates wt ON wt.workout_template_id=ps.workout_template_id
      WHERE ps.program_version_id=?
      ORDER BY ps.sequence`,
    active.program_version_id
  ).map((slot) => {
    if (slot.workout_kind === "STRENGTH") {
      return {
        ...slot,
        exercises: all(
          db,
          `SELECT te.template_exercise_id,te.sequence,e.exercise_id,e.name,e.load_mode,e.rep_mode,
                  e.load_progression_direction,te.target_sets,te.target_reps_min,te.target_reps_max,
                  te.target_rir_min,te.target_rir_max
             FROM template_exercises te
             JOIN exercises e ON e.exercise_id=te.exercise_id
            WHERE te.workout_template_id=?
            ORDER BY te.sequence`,
          slot.workout_template_id
        ),
        conditioning: null,
      };
    }
    const policy = one<Row>(
      db,
      "SELECT * FROM conditioning_policies WHERE workout_template_id=?",
      slot.workout_template_id
    );
    return {
      ...slot,
      exercises: [],
      conditioning: policy ? {
        ...policy,
        modalities: all(
          db,
          `SELECT cm.modality_id,cm.name
             FROM conditioning_policy_modalities cpm
             JOIN conditioning_modalities cm ON cm.modality_id=cpm.modality_id
            WHERE cpm.conditioning_policy_id=? AND cm.active=1
            ORDER BY cm.name`,
          policy.conditioning_policy_id
        ),
      } : null,
    };
  });

  return {
    active_program: active,
    cursor,
    slots,
  };
}

export function searchExercises(db: DatabaseSync, query: string, limit = 20) {
  const q = query.trim();
  if (!q || q.length > 200) throw new Error("Invalid exercise search query");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid exercise search limit");
  const like = `%${q.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  return all(
    db,
    `SELECT DISTINCT e.exercise_id,e.name,e.category,e.equipment_type,e.load_mode,e.rep_mode,
            e.load_progression_direction,e.active
       FROM exercises e
       LEFT JOIN exercise_aliases a ON a.exercise_id=e.exercise_id
      WHERE e.active=1
        AND (lower(e.name) LIKE ? ESCAPE '\\' OR lower(COALESCE(a.alias,'')) LIKE ? ESCAPE '\\')
      ORDER BY CASE WHEN lower(e.name)=lower(?) THEN 0 ELSE 1 END,e.name
      LIMIT ?`,
    like, like, q, limit
  );
}

export function restartProgramCycle(db: DatabaseSync) {
  return withTransaction(db, () => {
    if (getOpenSession(db)) throw new Error("Program cycle cannot restart while a session is open");
    const active = one<{program_version_id:string}>(
      db,
      "SELECT program_version_id FROM program_versions WHERE status='ACTIVE'"
    );
    if (!active) throw new Error("No active training program");
    const cursor = one<{cycle_number:number}>(
      db,
      "SELECT cycle_number FROM program_cursor WHERE program_version_id=?",
      active.program_version_id
    );
    if (!cursor) throw new Error("Active program is missing a cursor");
    const first = one<{program_slot_id:string; sequence:number; name:string}>(
      db,
      `SELECT ps.program_slot_id,ps.sequence,wt.name
         FROM program_slots ps
         JOIN workout_templates wt ON wt.workout_template_id=ps.workout_template_id
        WHERE ps.program_version_id=?
        ORDER BY ps.sequence LIMIT 1`,
      active.program_version_id
    );
    if (!first || first.sequence !== 1 || first.name !== "Strength A") {
      throw new Error("Active Program Version does not start with Strength A");
    }
    const nextCycle = cursor.cycle_number + 1;
    const now = nowIso();
    db.prepare(
      "UPDATE program_cursor SET next_program_slot_id=?,cycle_number=?,updated_at=? WHERE program_version_id=?"
    ).run(first.program_slot_id, nextCycle, now, active.program_version_id);
    db.prepare("INSERT INTO training_events VALUES(?,?,?,?,?,?)").run(
      newId("evt"), "PROGRAM_CYCLE_RESTARTED", "program_version", active.program_version_id,
      JSON.stringify({ previous_cycle_number: cursor.cycle_number, cycle_number: nextCycle, next_program_slot_id: first.program_slot_id }),
      now
    );
    return { replayed: false, recommendation: getRecommendation(db) };
  });
}

function nextSlot(db: DatabaseSync, versionId: string, sequence: number, cycle: number) {
  const next = one<{program_slot_id:string; sequence:number}>(
    db,
    "SELECT program_slot_id,sequence FROM program_slots WHERE program_version_id=? AND sequence>? ORDER BY sequence LIMIT 1",
    versionId, sequence
  );
  if (next) return { slot_id: next.program_slot_id, cycle_number: cycle };
  const first = one<{program_slot_id:string}>(
    db,
    "SELECT program_slot_id FROM program_slots WHERE program_version_id=? ORDER BY sequence LIMIT 1",
    versionId
  );
  if (!first) throw new Error("Program has no slots");
  return { slot_id: first.program_slot_id, cycle_number: cycle + 1 };
}

export function startProgramSession(
  db: DatabaseSync,
  params: { selected_program_slot_id?: string; timezone_at_start: string; local_date: string }
) {
  return withTransaction(db, () => {
    const existing = getOpenSession(db);
    if (existing) return { replayed: true, session: getSession(db, String(existing.training_session_id)) };

    const rec = getRecommendation(db);
    if (!rec.active_program || !rec.recommendation) throw new Error("No active training program");
    const recommended = rec.recommendation;
    const selectedId = params.selected_program_slot_id ?? recommended.program_slot_id;
    const selected = one<{program_slot_id:string; sequence:number; workout_template_id:string; name:string; workout_kind:string}>(
      db,
      `SELECT ps.program_slot_id,ps.sequence,ps.workout_template_id,wt.name,wt.workout_kind
         FROM program_slots ps JOIN workout_templates wt ON wt.workout_template_id=ps.workout_template_id
        WHERE ps.program_slot_id=? AND ps.program_version_id=?`,
      selectedId, rec.active_program.program_version_id
    );
    if (!selected) throw new Error("Selected slot does not belong to the active Program Version");

    let selectionSource: "PROGRAM_RECOMMENDATION" | "USER_FORWARD_OVERRIDE" | "USER_REPEAT" = "PROGRAM_RECOMMENDATION";
    if (selected.sequence > recommended.sequence) selectionSource = "USER_FORWARD_OVERRIDE";
    if (selected.sequence < recommended.sequence) selectionSource = "USER_REPEAT";

    const after = nextSlot(
      db,
      rec.active_program.program_version_id,
      selected.sequence,
      rec.active_program.cycle_number
    );
    const sessionId = newId("sess");
    const now = nowIso();

    db.prepare(`INSERT INTO training_sessions(
      training_session_id,program_version_id,workout_template_id,session_kind,session_source,
      recommended_program_slot_id,selected_program_slot_id,selection_source,
      cursor_before_slot_id,cursor_before_cycle_number,cursor_on_complete_slot_id,cursor_on_complete_cycle_number,
      status,started_at,timezone_at_start,local_date,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      sessionId,
      rec.active_program.program_version_id,
      selected.workout_template_id,
      selected.workout_kind,
      "PROGRAM",
      recommended.program_slot_id,
      selected.program_slot_id,
      selectionSource,
      recommended.program_slot_id,
      rec.active_program.cycle_number,
      selectionSource === "USER_REPEAT" ? recommended.program_slot_id : after.slot_id,
      selectionSource === "USER_REPEAT" ? rec.active_program.cycle_number : after.cycle_number,
      "ACTIVE", now, params.timezone_at_start, params.local_date, now
    );

    if (selected.workout_kind === "STRENGTH") {
      const template = all<{
        template_exercise_id:string;
        exercise_id:string;
        sequence:number;
        target_sets:number;
        target_reps_min:SQLInputValue;
        target_reps_max:SQLInputValue;
        target_rir_min:SQLInputValue;
        target_rir_max:SQLInputValue;
        progression_policy_json:string;
      }>(
        db,
        `SELECT template_exercise_id,exercise_id,sequence,target_sets,target_reps_min,target_reps_max,
                target_rir_min,target_rir_max,progression_policy_json
           FROM template_exercises
          WHERE workout_template_id=?
          ORDER BY sequence`,
        selected.workout_template_id
      );
      const insert = db.prepare(`INSERT INTO session_exercises(
        session_exercise_id,training_session_id,template_exercise_id,exercise_id,sequence,
        planned_sets,target_reps_min,target_reps_max,target_rir_min,target_rir_max,progression_policy_json,status
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'PENDING')`);
      for (const item of template) {
        insert.run(
          newId("sex"), sessionId, item.template_exercise_id, item.exercise_id, item.sequence,
          item.target_sets,item.target_reps_min,item.target_reps_max,item.target_rir_min,item.target_rir_max,
          item.progression_policy_json
        );
      }
    }

    db.prepare("INSERT INTO training_events VALUES(?,?,?,?,?,?)").run(
      newId("evt"), "SESSION_STARTED", "training_session", sessionId,
      JSON.stringify({
        recommended_slot: recommended.program_slot_id,
        selected_slot: selected.program_slot_id,
        selection_source: selectionSource,
      }),
      now
    );
    return { replayed: false, session: getSession(db, sessionId) };
  });
}

export type AdHocStrengthExercise = {
  exercise_id: string;
  planned_sets: number;
  target_reps_min: number | null;
  target_reps_max: number | null;
  target_rir_min: number | null;
  target_rir_max: number | null;
  progression_policy_json?: string;
};

export function startAdHocSession(
  db: DatabaseSync,
  params: {
    session_kind: "STRENGTH" | "CONDITIONING";
    timezone_at_start: string;
    local_date: string;
    strength_exercises?: AdHocStrengthExercise[];
  }
) {
  return withTransaction(db, () => {
    const existing = getOpenSession(db);
    if (existing) {
      return { replayed: true, session: getSession(db, String(existing.training_session_id)) };
    }
    if (
      params.session_kind === "STRENGTH" &&
      (!params.strength_exercises || params.strength_exercises.length === 0)
    ) {
      throw new Error("Ad-hoc strength session requires at least one exercise");
    }
    if (
      params.session_kind === "CONDITIONING" &&
      params.strength_exercises?.length
    ) {
      throw new Error("Conditioning session cannot include strength exercise plan");
    }

    const now = nowIso();
    const sessionId = newId("sess");
    db.prepare(`INSERT INTO training_sessions(
      training_session_id,program_version_id,workout_template_id,session_kind,session_source,
      recommended_program_slot_id,selected_program_slot_id,selection_source,
      cursor_before_slot_id,cursor_before_cycle_number,cursor_on_complete_slot_id,cursor_on_complete_cycle_number,
      status,started_at,timezone_at_start,local_date,created_at
    ) VALUES(?,NULL,NULL,?,'AD_HOC',NULL,NULL,'USER_AD_HOC',NULL,NULL,NULL,NULL,'ACTIVE',?,?,?,?)`).run(
      sessionId, params.session_kind, now, params.timezone_at_start, params.local_date, now
    );

    if (params.session_kind === "STRENGTH") {
      const insert = db.prepare(`INSERT INTO session_exercises(
        session_exercise_id,training_session_id,template_exercise_id,exercise_id,sequence,
        planned_sets,target_reps_min,target_reps_max,target_rir_min,target_rir_max,progression_policy_json,status
      ) VALUES(?,?,NULL,?,?,?,?,?,?,?,?,'PENDING')`);
      params.strength_exercises!.forEach((item, index) => {
        const exercise = one<{exercise_id:string; active:number}>(
          db,
          "SELECT exercise_id,active FROM exercises WHERE exercise_id=?",
          item.exercise_id
        );
        if (!exercise || exercise.active !== 1) {
          throw new Error(`Unknown or inactive exercise: ${item.exercise_id}`);
        }
        if (!Number.isInteger(item.planned_sets) || item.planned_sets < 1 || item.planned_sets > 20) {
          throw new Error("Invalid ad-hoc planned_sets");
        }
        const policy = item.progression_policy_json ?? "{}";
        parseProgressionPolicy(policy);
        insert.run(
          newId("sex"), sessionId, item.exercise_id, index + 1,
          item.planned_sets, item.target_reps_min, item.target_reps_max,
          item.target_rir_min, item.target_rir_max, policy
        );
      });
    }

    db.prepare("INSERT INTO training_events VALUES(?,?,?,?,?,?)").run(
      newId("evt"), "SESSION_STARTED", "training_session", sessionId,
      JSON.stringify({ session_source: "AD_HOC", session_kind: params.session_kind }), now
    );
    return { replayed: false, session: getSession(db, sessionId) };
  });
}

export function getSession(db: DatabaseSync, sessionId?: string) {
  const session = sessionId
    ? one(db, "SELECT * FROM training_sessions WHERE training_session_id=?", sessionId)
    : getOpenSession(db);
  if (!session) return null;

  const exercises = all(
    db,
    `SELECT se.*,e.name,e.load_mode,e.rep_mode,e.load_progression_direction
       FROM session_exercises se JOIN exercises e ON e.exercise_id=se.exercise_id
      WHERE se.training_session_id=? ORDER BY se.sequence`,
    session.training_session_id
  ).map((exercise) => ({
    ...exercise,
    sets: all(
      db,
      "SELECT * FROM session_sets WHERE session_exercise_id=? ORDER BY set_number",
      exercise.session_exercise_id
    ),
  }));

  return { ...session, exercises };
}

export type ConditioningSegmentInput = {
  sequence: number;
  segment_type: "WARMUP" | "WORK" | "RECOVERY" | "COOLDOWN";
  target_duration_sec?: number | null;
  target_distance_m?: number | null;
  target_hr_min?: number | null;
  target_hr_max?: number | null;
  target_hr_zone?: number | null;
  target_power_w?: number | null;
  target_cadence?: number | null;
  notes?: string | null;
};

export function createConditioningPrescription(
  db: DatabaseSync,
  params: {
    training_session_id: string;
    recommended_modality_id?: string | null;
    selected_modality_id: string;
    modality_selection_source: "AGENT_RECOMMENDATION" | "USER_OVERRIDE" | "USER_AD_HOC";
    protocol_summary?: string | null;
    segments: ConditioningSegmentInput[];
  }
) {
  return withTransaction(db, () => {
    const session = one<{
      status:string;
      session_kind:string;
      session_source:string;
      workout_template_id:SQLInputValue;
    }>(
      db,
      "SELECT status,session_kind,session_source,workout_template_id FROM training_sessions WHERE training_session_id=?",
      params.training_session_id
    );
    if (!session) throw new Error("Training session not found");
    if (session.status !== "ACTIVE") throw new Error("Conditioning session must be ACTIVE");
    if (session.session_kind !== "CONDITIONING") throw new Error("Session is not Conditioning");
    if (!params.segments.length) throw new Error("Conditioning prescription requires at least one segment");

    const existing = one<Row>(
      db,
      "SELECT * FROM conditioning_prescriptions WHERE training_session_id=?",
      params.training_session_id
    );
    if (existing) {
      if (
        existing.selected_modality_id !== params.selected_modality_id ||
        existing.recommended_modality_id !== (params.recommended_modality_id ?? null)
      ) {
        throw new Error("Conditioning session already has a different durable prescription");
      }
      return { replayed: true, prescription: getConditioningPrescription(db, String(existing.conditioning_prescription_id)) };
    }

    const selected = one<{modality_id:string; active:number}>(
      db,
      "SELECT modality_id,active FROM conditioning_modalities WHERE modality_id=?",
      params.selected_modality_id
    );
    if (!selected || selected.active !== 1) throw new Error("Selected Conditioning modality is unavailable");

    let policyId: string | null = null;
    if (session.workout_template_id != null) {
      const policy = one<{conditioning_policy_id:string}>(
        db,
        "SELECT conditioning_policy_id FROM conditioning_policies WHERE workout_template_id=?",
        session.workout_template_id
      );
      if (!policy) throw new Error("Program Conditioning template is missing a policy");
      policyId = policy.conditioning_policy_id;

      const selectedAllowed = one(
        db,
        "SELECT 1 AS ok FROM conditioning_policy_modalities WHERE conditioning_policy_id=? AND modality_id=?",
        policyId, params.selected_modality_id
      );
      if (!selectedAllowed) throw new Error("Selected modality is outside the active Conditioning policy");
      if (params.recommended_modality_id) {
        const recommendedAllowed = one(
          db,
          "SELECT 1 AS ok FROM conditioning_policy_modalities WHERE conditioning_policy_id=? AND modality_id=?",
          policyId, params.recommended_modality_id
        );
        if (!recommendedAllowed) throw new Error("Recommended modality is outside the active Conditioning policy");
      }
    } else if (params.modality_selection_source !== "USER_AD_HOC") {
      throw new Error("Ad-hoc Conditioning must use USER_AD_HOC modality source");
    }

    const now = nowIso();
    const prescriptionId = newId("cond");
    db.prepare(`INSERT INTO conditioning_prescriptions(
      conditioning_prescription_id,training_session_id,conditioning_policy_id,
      recommended_modality_id,selected_modality_id,modality_selection_source,protocol_summary,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      prescriptionId, params.training_session_id, policyId,
      params.recommended_modality_id ?? null, params.selected_modality_id,
      params.modality_selection_source, params.protocol_summary ?? null, now
    );

    const insert = db.prepare(`INSERT INTO conditioning_segments(
      conditioning_segment_id,conditioning_prescription_id,sequence,segment_type,
      target_duration_sec,target_distance_m,target_hr_min,target_hr_max,target_hr_zone,
      target_power_w,target_cadence,notes
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const seen = new Set<number>();
    for (const segment of params.segments) {
      if (!Number.isInteger(segment.sequence) || segment.sequence < 1 || seen.has(segment.sequence)) {
        throw new Error("Conditioning segment sequence must be unique positive integers");
      }
      seen.add(segment.sequence);
      if (
        segment.target_hr_min != null &&
        segment.target_hr_max != null &&
        segment.target_hr_min > segment.target_hr_max
      ) {
        throw new Error("Conditioning target HR minimum exceeds maximum");
      }
      insert.run(
        newId("cseg"), prescriptionId, segment.sequence, segment.segment_type,
        segment.target_duration_sec ?? null, segment.target_distance_m ?? null,
        segment.target_hr_min ?? null, segment.target_hr_max ?? null,
        segment.target_hr_zone ?? null, segment.target_power_w ?? null,
        segment.target_cadence ?? null, segment.notes ?? null
      );
    }

    db.prepare("INSERT INTO training_events VALUES(?,?,?,?,?,?)").run(
      newId("evt"), "CONDITIONING_PRESCRIBED", "training_session", params.training_session_id,
      JSON.stringify({
        recommended_modality_id: params.recommended_modality_id ?? null,
        selected_modality_id: params.selected_modality_id,
        modality_selection_source: params.modality_selection_source,
      }),
      now
    );
    return { replayed: false, prescription: getConditioningPrescription(db, prescriptionId) };
  });
}

export function getConditioningPrescription(db: DatabaseSync, prescriptionId: string) {
  const prescription = one<Row>(
    db,
    "SELECT * FROM conditioning_prescriptions WHERE conditioning_prescription_id=?",
    prescriptionId
  );
  if (!prescription) return null;
  return {
    ...prescription,
    segments: all(
      db,
      "SELECT * FROM conditioning_segments WHERE conditioning_prescription_id=? ORDER BY sequence",
      prescriptionId
    ),
    result: one(
      db,
      "SELECT * FROM conditioning_results WHERE conditioning_prescription_id=?",
      prescriptionId
    ) ?? null,
  };
}

export type ConditioningSegmentActual = {
  sequence: number;
  actual_duration_sec?: number | null;
  actual_distance_m?: number | null;
  actual_avg_hr?: number | null;
  actual_max_hr?: number | null;
  actual_power_w?: number | null;
  actual_cadence?: number | null;
  notes?: string | null;
};

export function completeConditioning(
  db: DatabaseSync,
  params: {
    conditioning_prescription_id: string;
    mode: "AS_PRESCRIBED" | "ACTUALS";
    actual_duration_sec?: number | null;
    actual_distance_m?: number | null;
    actual_avg_power_w?: number | null;
    actual_avg_cadence?: number | null;
    rpe?: number | null;
    notes?: string | null;
    segments?: ConditioningSegmentActual[];
  }
) {
  return withTransaction(db, () => {
    const prescription = one<{training_session_id:string}>(
      db,
      "SELECT training_session_id FROM conditioning_prescriptions WHERE conditioning_prescription_id=?",
      params.conditioning_prescription_id
    );
    if (!prescription) throw new Error("Conditioning prescription not found");
    const session = one<{status:string}>(
      db,
      "SELECT status FROM training_sessions WHERE training_session_id=?",
      prescription.training_session_id
    );
    if (!session || session.status !== "ACTIVE") throw new Error("Conditioning session must be ACTIVE");

    const existing = one(
      db,
      "SELECT conditioning_prescription_id FROM conditioning_results WHERE conditioning_prescription_id=?",
      params.conditioning_prescription_id
    );
    if (existing) {
      return { replayed: true, prescription: getConditioningPrescription(db, params.conditioning_prescription_id) };
    }

    const segments = all<Row>(
      db,
      "SELECT * FROM conditioning_segments WHERE conditioning_prescription_id=? ORDER BY sequence",
      params.conditioning_prescription_id
    );
    if (!segments.length) throw new Error("Conditioning prescription has no segments");

    if (params.rpe != null && (params.rpe < 0 || params.rpe > 10)) throw new Error("INVALID Conditioning RPE");

    if (params.mode === "AS_PRESCRIBED") {
      const update = db.prepare(`UPDATE conditioning_segments
        SET actual_duration_sec=target_duration_sec,
            actual_distance_m=target_distance_m,
            actual_power_w=target_power_w,
            actual_cadence=target_cadence
        WHERE conditioning_segment_id=?`);
      for (const segment of segments) update.run(segment.conditioning_segment_id);
    } else if (params.segments) {
      const bySequence = new Map(segments.map((row) => [Number(row.sequence), row]));
      const update = db.prepare(`UPDATE conditioning_segments
        SET actual_duration_sec=?,actual_distance_m=?,actual_avg_hr=?,actual_max_hr=?,
            actual_power_w=?,actual_cadence=?,notes=COALESCE(?,notes)
        WHERE conditioning_segment_id=?`);
      for (const actual of params.segments) {
        const target = bySequence.get(actual.sequence);
        if (!target) throw new Error(`Unknown Conditioning segment: ${actual.sequence}`);
        update.run(
          actual.actual_duration_sec ?? null, actual.actual_distance_m ?? null,
          actual.actual_avg_hr ?? null, actual.actual_max_hr ?? null,
          actual.actual_power_w ?? null, actual.actual_cadence ?? null,
          actual.notes ?? null, target.conditioning_segment_id
        );
      }
    }

    const refreshed = all<Row>(
      db,
      "SELECT * FROM conditioning_segments WHERE conditioning_prescription_id=? ORDER BY sequence",
      params.conditioning_prescription_id
    );
    const summedDuration = refreshed.every((x) => x.actual_duration_sec != null)
      ? refreshed.reduce((sum, x) => sum + Number(x.actual_duration_sec), 0)
      : null;
    const summedDistance = refreshed.every((x) => x.actual_distance_m != null)
      ? refreshed.reduce((sum, x) => sum + Number(x.actual_distance_m), 0)
      : null;

    db.prepare(`INSERT INTO conditioning_results(
      conditioning_prescription_id,actual_duration_sec,actual_distance_m,
      actual_avg_power_w,actual_avg_cadence,rpe,notes
    ) VALUES(?,?,?,?,?,?,?)`).run(
      params.conditioning_prescription_id,
      params.actual_duration_sec ?? summedDuration,
      params.actual_distance_m ?? summedDistance,
      params.actual_avg_power_w ?? null,
      params.actual_avg_cadence ?? null,
      params.rpe ?? null,
      params.notes ?? null
    );

    const now = nowIso();
    db.prepare("INSERT INTO training_events VALUES(?,?,?,?,?,?)").run(
      newId("evt"), "CONDITIONING_COMPLETED", "training_session", prescription.training_session_id,
      JSON.stringify({ mode: params.mode }), now
    );
    return { replayed: false, prescription: getConditioningPrescription(db, params.conditioning_prescription_id) };
  });
}

type ProgressionPolicy = {
  kind?: "DOUBLE_SUCCESS_THEN_INCREMENT" | "HOLD_LAST_LOAD";
  initial_load_kg?: number;
  increment_kg?: number;
  successful_exposures_required?: number;
};

function parseProgressionPolicy(raw: SQLInputValue): ProgressionPolicy {
  if (typeof raw !== "string" || !raw.trim()) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid progression policy JSON");
  }
  const policy = value as ProgressionPolicy;
  if (policy.initial_load_kg !== undefined && (!Number.isFinite(policy.initial_load_kg) || policy.initial_load_kg < 0)) {
    throw new Error("Invalid progression initial_load_kg");
  }
  if (policy.increment_kg !== undefined && (!Number.isFinite(policy.increment_kg) || policy.increment_kg <= 0)) {
    throw new Error("Invalid progression increment_kg");
  }
  if (policy.successful_exposures_required !== undefined &&
      (!Number.isInteger(policy.successful_exposures_required) ||
       policy.successful_exposures_required < 1 ||
       policy.successful_exposures_required > 10)) {
    throw new Error("Invalid successful_exposures_required");
  }
  return policy;
}

function uniformCompletedLoad(sets: Row[]): number | null | undefined {
  if (!sets.length) return undefined;
  const loads = sets.map((set) =>
    set.actual_load_kg == null ? null : Number(set.actual_load_kg)
  );
  if (loads.some((load) => load === null)) {
    return loads.every((load) => load === null) ? null : undefined;
  }
  const first = loads[0] as number;
  return loads.every((load) => Math.abs((load as number) - first) < 1e-9)
    ? first
    : undefined;
}

function exposureSucceeded(sets: Row[]): boolean {
  if (!sets.length) return false;
  return sets.every((set) => {
    if (set.status !== "COMPLETED" || set.actual_reps == null) return false;
    const targetReps = set.target_reps == null ? null : Number(set.target_reps);
    const actualReps = Number(set.actual_reps);
    if (targetReps !== null && actualReps < targetReps) return false;
    if (set.target_rir != null) {
      if (set.actual_rir == null || Number(set.actual_rir) < Number(set.target_rir)) return false;
    }
    return true;
  });
}

export function getProgressionCandidate(db: DatabaseSync, sessionExerciseId: string) {
  const current = one<{
    session_exercise_id:string;
    training_session_id:string;
    template_exercise_id:string;
    exercise_id:string;
    equipment_instance_id:SQLInputValue;
    started_at:SQLInputValue;
    local_date:string;
    load_mode:string;
    load_progression_direction:string;
    target_sets:number;
    target_reps_min:SQLInputValue;
    target_reps_max:SQLInputValue;
    target_rir_min:SQLInputValue;
    target_rir_max:SQLInputValue;
    exercise_policy:string;
    program_policy:string;
  }>(
    db,
    `SELECT se.session_exercise_id,se.training_session_id,se.template_exercise_id,se.exercise_id,
            se.equipment_instance_id,ts.started_at,ts.local_date,e.load_mode,e.load_progression_direction,
            se.planned_sets AS target_sets,se.target_reps_min,se.target_reps_max,se.target_rir_min,se.target_rir_max,
            se.progression_policy_json AS exercise_policy,
            COALESCE(pv.progression_policy_json,'{}') AS program_policy
       FROM session_exercises se
       JOIN training_sessions ts ON ts.training_session_id=se.training_session_id
       JOIN exercises e ON e.exercise_id=se.exercise_id
       LEFT JOIN program_versions pv ON pv.program_version_id=ts.program_version_id
      WHERE se.session_exercise_id=?`,
    sessionExerciseId
  );
  if (!current) throw new Error("Session exercise not found");

  const exercisePolicy = parseProgressionPolicy(current.exercise_policy);
  const programPolicy = parseProgressionPolicy(current.program_policy);
  const policy: ProgressionPolicy = { ...programPolicy, ...exercisePolicy };
  const required = policy.successful_exposures_required ?? 2;

  const prior = all<{
    session_exercise_id:string;
    started_at:SQLInputValue;
    local_date:string;
    equipment_instance_id:SQLInputValue;
  }>(
    db,
    `SELECT se.session_exercise_id,ts.started_at,ts.local_date,se.equipment_instance_id
       FROM session_exercises se
       JOIN training_sessions ts ON ts.training_session_id=se.training_session_id
      WHERE se.exercise_id=?
        AND se.session_exercise_id<>?
        AND se.status='COMPLETED'
        AND ts.status<>'VOIDED'
        AND ts.local_date<=?
        AND (
          (? IS NULL AND se.equipment_instance_id IS NULL)
          OR se.equipment_instance_id=?
        )
      ORDER BY ts.local_date DESC,COALESCE(ts.started_at,'') DESC,se.completed_at DESC
      LIMIT 10`,
    current.exercise_id,
    sessionExerciseId,
    current.local_date,
    current.equipment_instance_id,
    current.equipment_instance_id
  );

  const exposures = prior.map((row) => {
    const sets = all<Row>(
      db,
      "SELECT * FROM session_sets WHERE session_exercise_id=? ORDER BY set_number",
      row.session_exercise_id
    );
    return {
      session_exercise_id: row.session_exercise_id,
      local_date: row.local_date,
      started_at: row.started_at,
      load_kg: uniformCompletedLoad(sets),
      success: exposureSucceeded(sets),
      set_count: sets.length,
    };
  });

  const latestComparable = exposures.find((exposure) => exposure.load_kg !== undefined);
  let candidateLoad: number | null = policy.initial_load_kg ?? null;
  let basis = "INITIAL_LOAD";

  if (current.load_mode === "BODYWEIGHT" || current.load_mode === "NONE") {
    candidateLoad = null;
    basis = "NO_EXTERNAL_LOAD";
  } else if (latestComparable) {
    candidateLoad = latestComparable.load_kg ?? null;
    basis = "HOLD_LAST_COMPARABLE_LOAD";

    const successful = exposures.slice(0, required);
    const sameLoad =
      successful.length === required &&
      successful.every((exposure) => exposure.success) &&
      successful.every((exposure) => exposure.load_kg === latestComparable.load_kg);

    if (
      policy.kind === "DOUBLE_SUCCESS_THEN_INCREMENT" &&
      sameLoad &&
      candidateLoad !== null &&
      policy.increment_kg
    ) {
      if (current.load_progression_direction === "HIGHER_IS_HARDER") {
        candidateLoad += policy.increment_kg;
        basis = "SUCCESS_STREAK_INCREMENT";
      } else if (current.load_progression_direction === "LOWER_IS_HARDER") {
        candidateLoad = Math.max(0, candidateLoad - policy.increment_kg);
        basis = "SUCCESS_STREAK_DECREMENT_ASSISTANCE";
      }
    }
  } else if (policy.initial_load_kg === undefined) {
    candidateLoad = null;
    basis = "NO_COMPARABLE_HISTORY_OR_INITIAL_LOAD";
  }

  return {
    session_exercise_id: sessionExerciseId,
    exercise_id: current.exercise_id,
    target_sets: current.target_sets,
    target_reps_min: current.target_reps_min,
    target_reps_max: current.target_reps_max,
    target_rir_min: current.target_rir_min,
    target_rir_max: current.target_rir_max,
    candidate_load_kg: candidateLoad,
    basis,
    policy: {
      kind: policy.kind ?? "HOLD_LAST_LOAD",
      increment_kg: policy.increment_kg ?? null,
      successful_exposures_required: required,
      initial_load_kg: policy.initial_load_kg ?? null,
    },
    recent_exposures: exposures.slice(0, Math.max(required, 3)),
  };
}

export type PrescribedSet = {
  set_number: number;
  candidate_reps: number | null;
  candidate_load_kg: number | null;
  candidate_rir: number | null;
  target_reps: number | null;
  target_load_kg: number | null;
  target_rir: number | null;
  prescription_reason?: string | null;
};

function samePrescription(existing: Row[], requested: PrescribedSet[]) {
  return existing.length === requested.length && requested.every((set, index) => {
    const row = existing[index]!;
    return Number(row.set_number) === set.set_number
      && row.target_reps === set.target_reps
      && row.target_load_kg === set.target_load_kg
      && row.target_rir === set.target_rir;
  });
}

export function prescribeExercise(db: DatabaseSync, sessionExerciseId: string, sets: PrescribedSet[]) {
  return withTransaction(db, () => {
    const exercise = one<{session_exercise_id:string; training_session_id:string; status:string}>(
      db,
      "SELECT session_exercise_id,training_session_id,status FROM session_exercises WHERE session_exercise_id=?",
      sessionExerciseId
    );
    if (!exercise) throw new Error("Session exercise not found");

    const session = one<{status:string}>(
      db,
      "SELECT status FROM training_sessions WHERE training_session_id=?",
      exercise.training_session_id
    );
    if (!session || session.status !== "ACTIVE") throw new Error("Training session is not ACTIVE");

    const existing = all(
      db,
      "SELECT * FROM session_sets WHERE session_exercise_id=? ORDER BY set_number",
      sessionExerciseId
    );
    if (existing.length) {
      if (!samePrescription(existing, sets)) {
        throw new Error("Exercise already has a different durable prescription");
      }
      return { replayed: true, exercise: getSessionExercise(db, sessionExerciseId) };
    }
    if (!sets.length) throw new Error("At least one working set is required");

    const now = nowIso();
    const active = one(
      db,
      "SELECT session_exercise_id FROM session_exercises WHERE training_session_id=? AND status='ACTIVE'",
      exercise.training_session_id
    );
    if (active && active.session_exercise_id !== sessionExerciseId) {
      throw new Error("Another exercise is already ACTIVE");
    }

    db.prepare(
      "UPDATE session_exercises SET status='ACTIVE',prescribed_at=?,started_at=COALESCE(started_at,?) WHERE session_exercise_id=?"
    ).run(now, now, sessionExerciseId);

    const insert = db.prepare(`INSERT INTO session_sets(
      session_set_id,session_exercise_id,set_number,candidate_reps,candidate_load_kg,candidate_rir,
      target_reps,target_load_kg,target_rir,prescription_reason,status
    ) VALUES(?,?,?,?,?,?,?,?,?,?,'PLANNED')`);
    for (const set of sets) {
      insert.run(
        newId("set"), sessionExerciseId, set.set_number,
        set.candidate_reps, set.candidate_load_kg, set.candidate_rir,
        set.target_reps, set.target_load_kg, set.target_rir, set.prescription_reason ?? null
      );
    }

    db.prepare("INSERT INTO training_events VALUES(?,?,?,?,?,?)").run(
      newId("evt"), "EXERCISE_PRESCRIBED", "session_exercise", sessionExerciseId,
      JSON.stringify({ set_count: sets.length }), now
    );
    return { replayed: false, exercise: getSessionExercise(db, sessionExerciseId) };
  });
}

export function getSessionExercise(db: DatabaseSync, id: string) {
  const exercise = one(db, "SELECT * FROM session_exercises WHERE session_exercise_id=?", id);
  if (!exercise) return null;
  return {
    ...exercise,
    sets: all(db, "SELECT * FROM session_sets WHERE session_exercise_id=? ORDER BY set_number", id),
  };
}

export type ActualSet = {
  set_number: number;
  reps: number;
  load_kg: number | null;
  rir: number | null;
  notes?: string | null;
};

function validateActual(target: Row, actual: ActualSet) {
  if (!Number.isInteger(actual.reps) || actual.reps < 0 || actual.reps > 200) {
    throw new Error("INVALID reps");
  }
  if (actual.load_kg !== null && (!Number.isFinite(actual.load_kg) || actual.load_kg < 0 || actual.load_kg > 1000)) {
    throw new Error("INVALID load");
  }
  if (actual.rir !== null && (!Number.isFinite(actual.rir) || actual.rir < 0 || actual.rir > 10)) {
    throw new Error("INVALID RIR");
  }

  const targetLoad = target.target_load_kg == null ? null : Number(target.target_load_kg);
  if (targetLoad && actual.load_kg && actual.load_kg >= Math.max(targetLoad * 3, targetLoad + 150)) {
    throw new Error(`SUSPICIOUS load ${actual.load_kg}; target is ${targetLoad}`);
  }
  const targetReps = target.target_reps == null ? null : Number(target.target_reps);
  if (targetReps && actual.reps >= Math.max(targetReps * 4, targetReps + 30)) {
    throw new Error(`SUSPICIOUS reps ${actual.reps}; target is ${targetReps}`);
  }
}

export function completeExercise(
  db: DatabaseSync,
  sessionExerciseId: string,
  mode: "AS_PRESCRIBED" | "ACTUALS",
  actuals: ActualSet[] = []
) {
  return withTransaction(db, () => {
    const exercise = one<{training_session_id:string; status:string}>(
      db,
      "SELECT training_session_id,status FROM session_exercises WHERE session_exercise_id=?",
      sessionExerciseId
    );
    if (!exercise) throw new Error("Session exercise not found");

    const sets = all(
      db,
      "SELECT * FROM session_sets WHERE session_exercise_id=? ORDER BY set_number",
      sessionExerciseId
    );
    if (!sets.length) throw new Error("Exercise has no durable prescription");
    if (exercise.status === "COMPLETED") {
      return { replayed: true, exercise: getSessionExercise(db, sessionExerciseId) };
    }
    if (exercise.status !== "ACTIVE") throw new Error("Exercise is not ACTIVE");

    const resolved: ActualSet[] = mode === "AS_PRESCRIBED"
      ? sets.map((set) => ({
          set_number: Number(set.set_number),
          reps: Number(set.target_reps ?? 0),
          load_kg: set.target_load_kg == null ? null : Number(set.target_load_kg),
          rir: set.target_rir == null ? null : Number(set.target_rir),
        }))
      : actuals;
    if (resolved.length !== sets.length) {
      throw new Error("Actual set count does not match prescribed working-set count");
    }

    const update = db.prepare(
      "UPDATE session_sets SET actual_reps=?,actual_load_kg=?,actual_rir=?,status='COMPLETED',notes=? WHERE session_set_id=?"
    );
    resolved.forEach((actual, index) => {
      const target = sets[index]!;
      if (Number(target.set_number) !== actual.set_number) {
        throw new Error("Actual set numbers must match prescription order");
      }
      validateActual(target, actual);
      update.run(actual.reps, actual.load_kg, actual.rir, actual.notes ?? null, target.session_set_id);
    });

    const now = nowIso();
    db.prepare(
      "UPDATE session_exercises SET status='COMPLETED',completed_at=? WHERE session_exercise_id=?"
    ).run(now, sessionExerciseId);
    db.prepare("INSERT INTO training_events VALUES(?,?,?,?,?,?)").run(
      newId("evt"), "EXERCISE_COMPLETED", "session_exercise", sessionExerciseId,
      JSON.stringify({ mode }), now
    );
    return { replayed: false, exercise: getSessionExercise(db, sessionExerciseId) };
  });
}

export function deferExercise(db: DatabaseSync, sessionExerciseId: string) {
  return withTransaction(db, () => {
    const row = one<{status:string}>(
      db,
      "SELECT status FROM session_exercises WHERE session_exercise_id=?",
      sessionExerciseId
    );
    if (!row) throw new Error("Session exercise not found");
    if (row.status === "DEFERRED") {
      return { replayed: true, exercise: getSessionExercise(db, sessionExerciseId) };
    }
    if (!["ACTIVE","PENDING"].includes(row.status)) {
      throw new Error("Exercise cannot be deferred from current state");
    }
    db.prepare("UPDATE session_exercises SET status='DEFERRED' WHERE session_exercise_id=?")
      .run(sessionExerciseId);
    return { replayed: false, exercise: getSessionExercise(db, sessionExerciseId) };
  });
}

export function resumeExercise(db: DatabaseSync, sessionExerciseId: string) {
  return withTransaction(db, () => {
    const row = one<{training_session_id:string; status:string}>(
      db,
      "SELECT training_session_id,status FROM session_exercises WHERE session_exercise_id=?",
      sessionExerciseId
    );
    if (!row) throw new Error("Session exercise not found");
    if (row.status === "ACTIVE") {
      return { replayed: true, exercise: getSessionExercise(db, sessionExerciseId) };
    }
    if (row.status !== "DEFERRED") throw new Error("Only a DEFERRED exercise can be resumed");
    const active = one<{session_exercise_id:string}>(
      db,
      "SELECT session_exercise_id FROM session_exercises WHERE training_session_id=? AND status='ACTIVE'",
      row.training_session_id
    );
    if (active) throw new Error("Another exercise is already ACTIVE");
    db.prepare("UPDATE session_exercises SET status='ACTIVE' WHERE session_exercise_id=?")
      .run(sessionExerciseId);
    return { replayed: false, exercise: getSessionExercise(db, sessionExerciseId) };
  });
}

export function pauseSession(db: DatabaseSync, sessionId: string) {
  return withTransaction(db, () => {
    const session = one<{status:string}>(
      db, "SELECT status FROM training_sessions WHERE training_session_id=?", sessionId
    );
    if (!session) throw new Error("Training session not found");
    if (session.status === "PAUSED") {
      return { replayed: true, session: getSession(db, sessionId) };
    }
    if (session.status !== "ACTIVE") throw new Error("Only an ACTIVE session can be paused");
    const now = nowIso();
    db.prepare("UPDATE training_sessions SET status='PAUSED' WHERE training_session_id=?").run(sessionId);
    db.prepare("INSERT INTO training_session_pauses VALUES(?,?,?,NULL)")
      .run(newId("pause"), sessionId, now);
    return { replayed: false, session: getSession(db, sessionId) };
  });
}

export function resumeSession(db: DatabaseSync, sessionId: string) {
  return withTransaction(db, () => {
    const session = one<{status:string}>(
      db, "SELECT status FROM training_sessions WHERE training_session_id=?", sessionId
    );
    if (!session) throw new Error("Training session not found");
    if (session.status === "ACTIVE") {
      return { replayed: true, session: getSession(db, sessionId) };
    }
    if (session.status !== "PAUSED") throw new Error("Only a PAUSED session can be resumed");
    const now = nowIso();
    const pause = one<{pause_id:string}>(
      db,
      "SELECT pause_id FROM training_session_pauses WHERE training_session_id=? AND resumed_at IS NULL",
      sessionId
    );
    if (!pause) throw new Error("PAUSED session is missing an open pause interval");
    db.prepare("UPDATE training_session_pauses SET resumed_at=? WHERE pause_id=?")
      .run(now, pause.pause_id);
    db.prepare("UPDATE training_sessions SET status='ACTIVE' WHERE training_session_id=?").run(sessionId);
    return { replayed: false, session: getSession(db, sessionId) };
  });
}

function closeUnfinishedStrengthWork(db: DatabaseSync, sessionId: string, now: string, reason: string) {
  db.prepare(
    `UPDATE session_sets SET status='SKIPPED'
      WHERE session_exercise_id IN (
        SELECT session_exercise_id FROM session_exercises
        WHERE training_session_id=? AND status IN ('PENDING','ACTIVE','DEFERRED')
      ) AND status='PLANNED'`
  ).run(sessionId);
  db.prepare(
    `UPDATE session_exercises
        SET status='SKIPPED',adaptation_reason=COALESCE(adaptation_reason,?),completed_at=?
      WHERE training_session_id=? AND status IN ('PENDING','ACTIVE','DEFERRED')`
  ).run(reason, now, sessionId);
}

export function abandonSession(db: DatabaseSync, sessionId: string, reason?: string) {
  return withTransaction(db, () => {
    const session = one<{status:string}>(
      db, "SELECT status FROM training_sessions WHERE training_session_id=?", sessionId
    );
    if (!session) throw new Error("Training session not found");
    if (session.status === "ABANDONED") {
      return { replayed: true, session: getSession(db, sessionId) };
    }
    if (!["ACTIVE","PAUSED"].includes(session.status)) {
      throw new Error("Session cannot be abandoned from current state");
    }
    const now = nowIso();
    if (session.status === "PAUSED") {
      db.prepare(
        "UPDATE training_session_pauses SET resumed_at=? WHERE training_session_id=? AND resumed_at IS NULL"
      ).run(now, sessionId);
    }
    closeUnfinishedStrengthWork(db, sessionId, now, reason ?? "SESSION_ABANDONED");
    db.prepare(
      "UPDATE training_sessions SET status='ABANDONED',ended_at=?,overall_feedback=COALESCE(?,overall_feedback) WHERE training_session_id=?"
    ).run(now, reason ?? null, sessionId);
    return { replayed: false, session: getSession(db, sessionId) };
  });
}

export function substituteExercise(
  db: DatabaseSync,
  sessionExerciseId: string,
  replacementExerciseId: string,
  reason?: string,
  equipmentInstanceId?: string | null,
) {
  return withTransaction(db, () => {
    const current = one<{
      training_session_id:string;
      exercise_id:string;
      substituted_from_exercise_id:SQLInputValue;
      status:string;
    }>(
      db,
      "SELECT training_session_id,exercise_id,substituted_from_exercise_id,status FROM session_exercises WHERE session_exercise_id=?",
      sessionExerciseId
    );
    if (!current) throw new Error("Session exercise not found");
    const session = one<{status:string}>(
      db,
      "SELECT status FROM training_sessions WHERE training_session_id=?",
      current.training_session_id
    );
    if (!session || session.status !== "ACTIVE") throw new Error("Training session is not ACTIVE");
    if (!["PENDING","ACTIVE","DEFERRED"].includes(current.status)) {
      throw new Error("Exercise cannot be substituted from current state");
    }
    if (current.exercise_id === replacementExerciseId) {
      return { replayed: true, exercise: getSessionExercise(db, sessionExerciseId) };
    }
    const replacement = one<{exercise_id:string; active:number}>(
      db,
      "SELECT exercise_id,active FROM exercises WHERE exercise_id=?",
      replacementExerciseId
    );
    if (!replacement || replacement.active !== 1) throw new Error("Replacement exercise is unavailable");
    if (equipmentInstanceId) {
      const equipment = one<{active:number}>(
        db,
        "SELECT active FROM equipment_instances WHERE equipment_instance_id=?",
        equipmentInstanceId
      );
      if (!equipment || equipment.active !== 1) throw new Error("Replacement equipment instance is unavailable");
    }

    const sets = all<Row>(
      db,
      "SELECT * FROM session_sets WHERE session_exercise_id=? ORDER BY set_number",
      sessionExerciseId
    );
    if (sets.some((set) => set.status === "COMPLETED" || set.actual_reps != null || set.actual_load_kg != null || set.actual_rir != null)) {
      throw new Error("Exercise with completed work cannot be substituted");
    }

    const now = nowIso();
    const originalExerciseId = current.substituted_from_exercise_id == null
      ? current.exercise_id
      : String(current.substituted_from_exercise_id);
    db.prepare("DELETE FROM session_sets WHERE session_exercise_id=?").run(sessionExerciseId);
    db.prepare(`UPDATE session_exercises
      SET exercise_id=?,substituted_from_exercise_id=?,equipment_instance_id=?,status='PENDING',
          progression_policy_json='{}',adaptation_reason=?,prescribed_at=NULL,started_at=NULL
      WHERE session_exercise_id=?`).run(
      replacementExerciseId, originalExerciseId, equipmentInstanceId ?? null,
      reason ?? "SESSION_SUBSTITUTION", sessionExerciseId
    );
    db.prepare("INSERT INTO training_events VALUES(?,?,?,?,?,?)").run(
      newId("evt"), "EXERCISE_SUBSTITUTED", "session_exercise", sessionExerciseId,
      JSON.stringify({
        original_exercise_id: current.exercise_id,
        canonical_original_exercise_id: originalExerciseId,
        replacement_exercise_id: replacementExerciseId,
        equipment_instance_id: equipmentInstanceId ?? null,
        reason: reason ?? null,
        superseded_prescription: sets,
      }),
      now
    );
    return { replayed: false, exercise: getSessionExercise(db, sessionExerciseId) };
  });
}

export function skipExercise(db: DatabaseSync, sessionExerciseId: string, reason?: string) {
  return withTransaction(db, () => {
    const row = one<{status:string}>(
      db,
      "SELECT status FROM session_exercises WHERE session_exercise_id=?",
      sessionExerciseId
    );
    if (!row) throw new Error("Session exercise not found");
    if (row.status === "SKIPPED") {
      return { replayed: true, exercise: getSessionExercise(db, sessionExerciseId) };
    }
    if (row.status === "COMPLETED") throw new Error("Completed exercise cannot be skipped");

    db.prepare(
      "UPDATE session_sets SET status='SKIPPED' WHERE session_exercise_id=? AND status='PLANNED'"
    ).run(sessionExerciseId);
    db.prepare(
      "UPDATE session_exercises SET status='SKIPPED',adaptation_reason=?,completed_at=? WHERE session_exercise_id=?"
    ).run(reason ?? null, nowIso(), sessionExerciseId);
    return { replayed: false, exercise: getSessionExercise(db, sessionExerciseId) };
  });
}

export function finishSession(db: DatabaseSync, sessionId: string, overallFeedback?: string | null) {
  return withTransaction(db, () => {
    const session = one<any>(
      db,
      "SELECT * FROM training_sessions WHERE training_session_id=?",
      sessionId
    );
    if (!session) throw new Error("Training session not found");
    if (session.status === "COMPLETED") {
      return { replayed: true, session: getSession(db, sessionId), next_recommendation: getRecommendation(db) };
    }
    if (!["ACTIVE","PAUSED"].includes(session.status)) {
      throw new Error("Session cannot be completed from current state");
    }

    const now = nowIso();

    if (session.session_kind === "CONDITIONING") {
      const result = one(
        db,
        `SELECT cr.conditioning_prescription_id
           FROM conditioning_prescriptions cp
           JOIN conditioning_results cr
             ON cr.conditioning_prescription_id=cp.conditioning_prescription_id
          WHERE cp.training_session_id=?`,
        sessionId
      );
      if (!result) {
        throw new Error("Conditioning result must be recorded before session completion");
      }
    }

    if (session.status === "PAUSED") {
      db.prepare(
        "UPDATE training_session_pauses SET resumed_at=? WHERE training_session_id=? AND resumed_at IS NULL"
      ).run(now, sessionId);
    }
    closeUnfinishedStrengthWork(db, sessionId, now, "SESSION_COMPLETED_EARLY");

    const skipped = Number((
      db.prepare(
        "SELECT count(*) n FROM session_exercises WHERE training_session_id=? AND status='SKIPPED'"
      ).get(sessionId) as { n:number }
    ).n);

    db.prepare(
      "UPDATE training_sessions SET status='COMPLETED',ended_at=?,overall_feedback=? WHERE training_session_id=?"
    ).run(now, overallFeedback ?? null, sessionId);

    if (session.session_source === "PROGRAM" && session.selected_program_slot_id) {
      const selected = one<{sequence:number}>(
        db,
        "SELECT sequence FROM program_slots WHERE program_slot_id=?",
        session.selected_program_slot_id
      )!;
      const before = one<{sequence:number}>(
        db,
        "SELECT sequence FROM program_slots WHERE program_slot_id=?",
        session.cursor_before_slot_id
      )!;

      if (session.selection_source === "USER_FORWARD_OVERRIDE") {
        const crossed = all<{program_slot_id:string}>(
          db,
          "SELECT program_slot_id FROM program_slots WHERE program_version_id=? AND sequence>=? AND sequence<? ORDER BY sequence",
          session.program_version_id, before.sequence, selected.sequence
        );
        const ins = db.prepare(
          "INSERT OR IGNORE INTO program_slot_outcomes VALUES(?,?,?,?,?,?,?)"
        );
        for (const slot of crossed) {
          ins.run(
            newId("out"), session.program_version_id, session.cursor_before_cycle_number,
            slot.program_slot_id, sessionId, "SKIPPED_FORWARD_OVERRIDE", now
          );
        }
      }

      if (session.selection_source !== "USER_REPEAT") {
        db.prepare(
          "INSERT OR REPLACE INTO program_slot_outcomes VALUES(?,?,?,?,?,?,?)"
        ).run(
          newId("out"), session.program_version_id, session.cursor_before_cycle_number,
          session.selected_program_slot_id, sessionId,
          skipped > 0 ? "COMPLETED_PARTIAL" : "COMPLETED", now
        );
        db.prepare(
          "UPDATE program_cursor SET next_program_slot_id=?,cycle_number=?,updated_at=? WHERE program_version_id=?"
        ).run(
          session.cursor_on_complete_slot_id,
          session.cursor_on_complete_cycle_number,
          now,
          session.program_version_id
        );
      }
    }

    return {
      replayed: false,
      session: getSession(db, sessionId),
      next_recommendation: getRecommendation(db),
    };
  });
}

export function voidSession(db: DatabaseSync, sessionId: string, reason?: string) {
  return withTransaction(db, () => {
    const session = one<{status:string}>(
      db,
      "SELECT status FROM training_sessions WHERE training_session_id=?",
      sessionId
    );
    if (!session) throw new Error("Training session not found");
    if (session.status === "VOIDED") {
      return { replayed: true, session: getSession(db, sessionId) };
    }
    if (session.status === "COMPLETED") {
      throw new Error("Completed session must be corrected, not voided through this tool");
    }
    db.prepare(
      "UPDATE training_sessions SET status='VOIDED',ended_at=?,overall_feedback=COALESCE(?,overall_feedback) WHERE training_session_id=?"
    ).run(nowIso(), reason ?? null, sessionId);
    return { replayed: false, session: getSession(db, sessionId) };
  });
}

export function correctSetResult(
  db: DatabaseSync,
  sessionSetId: string,
  patch: { reps?: number; load_kg?: number | null; rir?: number | null },
  reason?: string,
) {
  return withTransaction(db, () => {
    const set = one<Row>(
      db,
      `SELECT ss.*,ts.status AS session_status
         FROM session_sets ss
         JOIN session_exercises se ON se.session_exercise_id=ss.session_exercise_id
         JOIN training_sessions ts ON ts.training_session_id=se.training_session_id
        WHERE ss.session_set_id=?`,
      sessionSetId
    );
    if (!set) throw new Error("Session set not found");
    if (set.status !== "COMPLETED") throw new Error("Only a completed working set can be corrected");
    if (set.session_status === "VOIDED") throw new Error("VOIDED session data is not corrected");

    const fields: Array<["actual_reps"|"actual_load_kg"|"actual_rir", SQLInputValue]> = [];
    if (patch.reps !== undefined) fields.push(["actual_reps", patch.reps]);
    if (patch.load_kg !== undefined) fields.push(["actual_load_kg", patch.load_kg]);
    if (patch.rir !== undefined) fields.push(["actual_rir", patch.rir]);
    if (fields.length !== 1) throw new Error("A correction must change exactly one result field");

    const [field, value] = fields[0]!;
    const candidate: ActualSet = {
      set_number: Number(set.set_number),
      reps: field === "actual_reps" ? Number(value) : Number(set.actual_reps),
      load_kg: field === "actual_load_kg" ? (value == null ? null : Number(value)) : (set.actual_load_kg == null ? null : Number(set.actual_load_kg)),
      rir: field === "actual_rir" ? (value == null ? null : Number(value)) : (set.actual_rir == null ? null : Number(set.actual_rir)),
    };
    validateActual(set, candidate);

    const previous = set[field];
    if (previous === value) {
      return { replayed: true, set: one<Row>(db, "SELECT * FROM session_sets WHERE session_set_id=?", sessionSetId) };
    }

    const now = nowIso();
    db.prepare(`UPDATE session_sets SET ${field}=? WHERE session_set_id=?`).run(value, sessionSetId);
    db.prepare(
      "INSERT INTO data_corrections VALUES(?,?,?,?,?,?,?,?,?)"
    ).run(
      newId("corr"), "session_set", sessionSetId, field,
      JSON.stringify(previous), JSON.stringify(value), reason ?? null, "USER_CORRECTION", now
    );
    db.prepare("INSERT INTO training_events VALUES(?,?,?,?,?,?)").run(
      newId("evt"), "SET_RESULT_CORRECTED", "session_set", sessionSetId,
      JSON.stringify({ field, before: previous, after: value, reason: reason ?? null }), now
    );
    return { replayed: false, set: one<Row>(db, "SELECT * FROM session_sets WHERE session_set_id=?", sessionSetId) };
  });
}

export type ProgramChangeType =
  | "REPLACE_EXERCISE"
  | "UPDATE_EXERCISE_TARGETS"
  | "UPDATE_CONDITIONING_POLICY";

export function proposeProgramChange(
  db: DatabaseSync,
  params: {
    change_type: ProgramChangeType;
    proposal: Record<string, unknown>;
    rationale: string;
    created_by?: "TRAINING_AGENT" | "USER";
  }
) {
  return withTransaction(db, () => {
    const active = one<{program_version_id:string}>(
      db,
      "SELECT program_version_id FROM program_versions WHERE status='ACTIVE'"
    );
    if (!active) throw new Error("No active Program Version");
    const proposalId = newId("proposal");
    const now = nowIso();
    db.prepare(`INSERT INTO program_change_proposals(
      proposal_id,base_program_version_id,created_by,change_type,proposal_json,rationale,
      status,decision_actor,decided_at,applied_program_version_id,created_at
    ) VALUES(?,?,?,?,?,?,'PENDING',NULL,NULL,NULL,?)`).run(
      proposalId, active.program_version_id, params.created_by ?? "TRAINING_AGENT",
      params.change_type, JSON.stringify(params.proposal), params.rationale, now
    );
    return one<Row>(
      db,
      "SELECT * FROM program_change_proposals WHERE proposal_id=?",
      proposalId
    );
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing or invalid ${field}`);
  return value;
}
function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${field}`);
  return value;
}

function cloneProgramVersion(db: DatabaseSync, baseVersionId: string, createdBy: "USER" | "HEALTH_MAIN", reason: string) {
  const base = one<{
    program_id:string;
    version_number:number;
    progression_policy_json:string;
    status:string;
  }>(
    db,
    "SELECT program_id,version_number,progression_policy_json,status FROM program_versions WHERE program_version_id=?",
    baseVersionId
  );
  if (!base || base.status !== "ACTIVE") throw new Error("Program change base must be the active version");

  const versionNumber = Number((
    db.prepare("SELECT COALESCE(MAX(version_number),0)+1 AS n FROM program_versions WHERE program_id=?")
      .get(base.program_id) as { n:number }
  ).n);
  const newVersionId = newId("ver");
  const now = nowIso();
  db.prepare(`INSERT INTO program_versions(
    program_version_id,program_id,version_number,status,progression_policy_json,created_by,
    decision_reason,activated_at,retired_at,created_at
  ) VALUES(?,?,?,'DRAFT',?,?,?,NULL,NULL,?)`).run(
    newVersionId, base.program_id, versionNumber,
    base.progression_policy_json, createdBy, reason, now
  );

  const templateMap = new Map<string,string>();
  const templates = all<Row>(
    db,
    "SELECT * FROM workout_templates WHERE program_version_id=? ORDER BY rowid",
    baseVersionId
  );
  for (const template of templates) {
    const newTemplateId = newId("tpl");
    templateMap.set(String(template.workout_template_id), newTemplateId);
    db.prepare("INSERT INTO workout_templates VALUES(?,?,?,?,?)").run(
      newTemplateId, newVersionId, template.name, template.workout_kind, template.notes
    );
  }

  const slotMap = new Map<string,string>();
  const slots = all<Row>(
    db,
    "SELECT * FROM program_slots WHERE program_version_id=? ORDER BY sequence",
    baseVersionId
  );
  for (const slot of slots) {
    const newSlotId = newId("slot");
    slotMap.set(String(slot.program_slot_id), newSlotId);
    const mappedTemplate = templateMap.get(String(slot.workout_template_id));
    if (!mappedTemplate) throw new Error("Program clone lost workout template mapping");
    db.prepare("INSERT INTO program_slots VALUES(?,?,?,?)").run(
      newSlotId, newVersionId, slot.sequence, mappedTemplate
    );
  }

  const templateExerciseMap = new Map<string,string>();
  const templateExercises = all<Row>(
    db,
    `SELECT te.* FROM template_exercises te
       JOIN workout_templates wt ON wt.workout_template_id=te.workout_template_id
      WHERE wt.program_version_id=?
      ORDER BY wt.rowid,te.sequence`,
    baseVersionId
  );
  for (const te of templateExercises) {
    const newIdValue = newId("te");
    templateExerciseMap.set(String(te.template_exercise_id), newIdValue);
    const mappedTemplate = templateMap.get(String(te.workout_template_id));
    if (!mappedTemplate) throw new Error("Program clone lost template exercise mapping");
    db.prepare(`INSERT INTO template_exercises(
      template_exercise_id,workout_template_id,exercise_id,sequence,target_sets,
      target_reps_min,target_reps_max,target_rir_min,target_rir_max,progression_policy_json,notes
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      newIdValue, mappedTemplate, te.exercise_id, te.sequence, te.target_sets,
      te.target_reps_min, te.target_reps_max, te.target_rir_min, te.target_rir_max,
      te.progression_policy_json, te.notes
    );
  }

  const conditioningPolicyMap = new Map<string,string>();
  const policies = all<Row>(
    db,
    `SELECT cp.* FROM conditioning_policies cp
       JOIN workout_templates wt ON wt.workout_template_id=cp.workout_template_id
      WHERE wt.program_version_id=?`,
    baseVersionId
  );
  for (const policy of policies) {
    const newPolicyId = newId("cp");
    conditioningPolicyMap.set(String(policy.conditioning_policy_id), newPolicyId);
    const mappedTemplate = templateMap.get(String(policy.workout_template_id));
    if (!mappedTemplate) throw new Error("Program clone lost Conditioning template mapping");
    db.prepare(`INSERT INTO conditioning_policies(
      conditioning_policy_id,workout_template_id,objective,min_duration_sec,max_duration_sec,intensity_basis,notes
    ) VALUES(?,?,?,?,?,?,?)`).run(
      newPolicyId, mappedTemplate, policy.objective, policy.min_duration_sec,
      policy.max_duration_sec, policy.intensity_basis, policy.notes
    );
    const modalities = all<{modality_id:string}>(
      db,
      "SELECT modality_id FROM conditioning_policy_modalities WHERE conditioning_policy_id=?",
      policy.conditioning_policy_id
    );
    for (const modality of modalities) {
      db.prepare("INSERT INTO conditioning_policy_modalities VALUES(?,?)")
        .run(newPolicyId, modality.modality_id);
    }
  }

  return {
    newVersionId,
    templateMap,
    slotMap,
    templateExerciseMap,
    conditioningPolicyMap,
  };
}

function applyProgramProposalPayload(
  db: DatabaseSync,
  changeType: ProgramChangeType,
  proposal: Record<string, unknown>,
  maps: ReturnType<typeof cloneProgramVersion>,
) {
  if (changeType === "REPLACE_EXERCISE") {
    const sourceId = requiredString(proposal.template_exercise_id, "template_exercise_id");
    const replacementExerciseId = requiredString(proposal.replacement_exercise_id, "replacement_exercise_id");
    const targetId = maps.templateExerciseMap.get(sourceId);
    if (!targetId) throw new Error("Program proposal references a template exercise outside the base version");
    const exercise = one<{active:number}>(db, "SELECT active FROM exercises WHERE exercise_id=?", replacementExerciseId);
    if (!exercise || exercise.active !== 1) throw new Error("Replacement exercise is unavailable");
    db.prepare("UPDATE template_exercises SET exercise_id=? WHERE template_exercise_id=?")
      .run(replacementExerciseId, targetId);
    return;
  }

  if (changeType === "UPDATE_EXERCISE_TARGETS") {
    const sourceId = requiredString(proposal.template_exercise_id, "template_exercise_id");
    const targetId = maps.templateExerciseMap.get(sourceId);
    if (!targetId) throw new Error("Program proposal references a template exercise outside the base version");
    const current = one<Row>(db, "SELECT * FROM template_exercises WHERE template_exercise_id=?", targetId)!;
    const targetSets = optionalNumber(proposal.target_sets, "target_sets") ?? Number(current.target_sets);
    const repsMin = proposal.target_reps_min === undefined ? current.target_reps_min : proposal.target_reps_min;
    const repsMax = proposal.target_reps_max === undefined ? current.target_reps_max : proposal.target_reps_max;
    const rirMin = proposal.target_rir_min === undefined ? current.target_rir_min : proposal.target_rir_min;
    const rirMax = proposal.target_rir_max === undefined ? current.target_rir_max : proposal.target_rir_max;
    const progression = proposal.progression_policy_json === undefined
      ? String(current.progression_policy_json)
      : requiredString(proposal.progression_policy_json, "progression_policy_json");
    parseProgressionPolicy(progression);
    if (!Number.isInteger(targetSets) || targetSets < 1 || targetSets > 20) throw new Error("Invalid target_sets");
    if (repsMin != null && (typeof repsMin !== "number" || repsMin < 0)) throw new Error("Invalid target_reps_min");
    if (repsMax != null && (typeof repsMax !== "number" || repsMax < 0)) throw new Error("Invalid target_reps_max");
    if (rirMin != null && (typeof rirMin !== "number" || rirMin < 0)) throw new Error("Invalid target_rir_min");
    if (rirMax != null && (typeof rirMax !== "number" || rirMax < 0)) throw new Error("Invalid target_rir_max");
    if (repsMin != null && repsMax != null && Number(repsMin) > Number(repsMax)) throw new Error("Invalid rep range");
    if (rirMin != null && rirMax != null && Number(rirMin) > Number(rirMax)) throw new Error("Invalid RIR range");
    db.prepare(`UPDATE template_exercises
      SET target_sets=?,target_reps_min=?,target_reps_max=?,target_rir_min=?,target_rir_max=?,progression_policy_json=?
      WHERE template_exercise_id=?`).run(
      targetSets, repsMin as SQLInputValue, repsMax as SQLInputValue,
      rirMin as SQLInputValue, rirMax as SQLInputValue, progression, targetId
    );
    return;
  }

  if (changeType === "UPDATE_CONDITIONING_POLICY") {
    const sourcePolicyId = requiredString(proposal.conditioning_policy_id, "conditioning_policy_id");
    const targetPolicyId = maps.conditioningPolicyMap.get(sourcePolicyId);
    if (!targetPolicyId) throw new Error("Program proposal references a Conditioning policy outside the base version");
    const current = one<Row>(
      db,
      "SELECT * FROM conditioning_policies WHERE conditioning_policy_id=?",
      targetPolicyId
    )!;
    const objective = proposal.objective === undefined
      ? String(current.objective)
      : requiredString(proposal.objective, "objective");
    const minDuration = proposal.min_duration_sec === undefined ? current.min_duration_sec : proposal.min_duration_sec;
    const maxDuration = proposal.max_duration_sec === undefined ? current.max_duration_sec : proposal.max_duration_sec;
    const intensity = proposal.intensity_basis === undefined ? current.intensity_basis : proposal.intensity_basis;
    if (minDuration != null && (typeof minDuration !== "number" || minDuration < 0)) throw new Error("Invalid min_duration_sec");
    if (maxDuration != null && (typeof maxDuration !== "number" || maxDuration < 0)) throw new Error("Invalid max_duration_sec");
    if (minDuration != null && maxDuration != null && Number(minDuration) > Number(maxDuration)) throw new Error("Invalid Conditioning duration range");
    db.prepare(`UPDATE conditioning_policies
      SET objective=?,min_duration_sec=?,max_duration_sec=?,intensity_basis=?
      WHERE conditioning_policy_id=?`).run(
      objective, minDuration as SQLInputValue, maxDuration as SQLInputValue,
      intensity as SQLInputValue, targetPolicyId
    );
    if (proposal.modality_ids !== undefined) {
      if (!Array.isArray(proposal.modality_ids) || proposal.modality_ids.length === 0) {
        throw new Error("modality_ids must be a non-empty array");
      }
      db.prepare("DELETE FROM conditioning_policy_modalities WHERE conditioning_policy_id=?")
        .run(targetPolicyId);
      for (const raw of proposal.modality_ids) {
        const modalityId = requiredString(raw, "modality_id");
        const modality = one<{active:number}>(db, "SELECT active FROM conditioning_modalities WHERE modality_id=?", modalityId);
        if (!modality || modality.active !== 1) throw new Error(`Unavailable Conditioning modality: ${modalityId}`);
        db.prepare("INSERT INTO conditioning_policy_modalities VALUES(?,?)").run(targetPolicyId, modalityId);
      }
    }
    return;
  }

  throw new Error(`Unsupported program change type: ${changeType}`);
}

export function applyApprovedProgramChange(
  db: DatabaseSync,
  proposalId: string,
  decisionActor: "USER" | "HEALTH_MAIN" = "USER",
) {
  return withTransaction(db, () => {
    if (getOpenSession(db)) throw new Error("Program Version cannot change while a session is open");
    const proposal = one<Row>(
      db,
      "SELECT * FROM program_change_proposals WHERE proposal_id=?",
      proposalId
    );
    if (!proposal) throw new Error("Program change proposal not found");
    if (proposal.status === "APPLIED") {
      return {
        replayed: true,
        proposal,
        active_program: one<Row>(db, "SELECT * FROM program_versions WHERE status='ACTIVE'"),
      };
    }
    if (proposal.status !== "PENDING" && proposal.status !== "APPROVED") {
      throw new Error("Program change proposal is not applicable");
    }
    const active = one<{program_version_id:string}>(
      db,
      "SELECT program_version_id FROM program_versions WHERE status='ACTIVE'"
    );
    if (!active || active.program_version_id !== proposal.base_program_version_id) {
      throw new Error("Program change proposal base is stale");
    }

    const changeType = String(proposal.change_type) as ProgramChangeType;
    const payload = JSON.parse(String(proposal.proposal_json)) as Record<string, unknown>;
    const maps = cloneProgramVersion(
      db,
      String(proposal.base_program_version_id),
      decisionActor,
      String(proposal.rationale)
    );
    applyProgramProposalPayload(db, changeType, payload, maps);

    const first = one<{program_slot_id:string; name:string}>(
      db,
      `SELECT ps.program_slot_id,wt.name
         FROM program_slots ps JOIN workout_templates wt ON wt.workout_template_id=ps.workout_template_id
        WHERE ps.program_version_id=?
        ORDER BY ps.sequence LIMIT 1`,
      maps.newVersionId
    );
    if (!first || first.name !== "Strength A") {
      throw new Error("New Program Version must start with Strength A");
    }

    const now = nowIso();
    db.prepare("UPDATE program_versions SET status='RETIRED',retired_at=? WHERE program_version_id=?")
      .run(now, proposal.base_program_version_id);
    db.prepare("UPDATE program_versions SET status='ACTIVE',activated_at=? WHERE program_version_id=?")
      .run(now, maps.newVersionId);
    db.prepare("INSERT INTO program_cursor VALUES(?,?,?,?)")
      .run(maps.newVersionId, 1, first.program_slot_id, now);
    db.prepare(`UPDATE program_change_proposals
      SET status='APPLIED',decision_actor=?,decided_at=?,applied_program_version_id=?
      WHERE proposal_id=?`).run(decisionActor, now, maps.newVersionId, proposalId);
    db.prepare("INSERT INTO training_events VALUES(?,?,?,?,?,?)").run(
      newId("evt"), "PROGRAM_VERSION_ACTIVATED", "program_version", maps.newVersionId,
      JSON.stringify({ base_program_version_id: proposal.base_program_version_id, proposal_id: proposalId }), now
    );

    return {
      replayed: false,
      proposal: one<Row>(db, "SELECT * FROM program_change_proposals WHERE proposal_id=?", proposalId),
      active_program: one<Row>(db, "SELECT * FROM program_versions WHERE program_version_id=?", maps.newVersionId),
      recommendation: getRecommendation(db),
    };
  });
}

export function recordTrainingFeedback(
  db: DatabaseSync,
  params: {
    training_session_id: string;
    session_exercise_id?: string | null;
    raw_text: string;
  }
) {
  return withTransaction(db, () => {
    const session = one(
      db,
      "SELECT training_session_id FROM training_sessions WHERE training_session_id=?",
      params.training_session_id
    );
    if (!session) throw new Error("Training session not found");
    if (params.session_exercise_id) {
      const exercise = one<{training_session_id:string}>(
        db,
        "SELECT training_session_id FROM session_exercises WHERE session_exercise_id=?",
        params.session_exercise_id
      );
      if (!exercise || exercise.training_session_id !== params.training_session_id) {
        throw new Error("Feedback exercise does not belong to the Training Session");
      }
    }
    const text = params.raw_text.trim();
    if (!text || text.length > 4000) throw new Error("Invalid training feedback text");
    const feedbackId = newId("feedback");
    const now = nowIso();
    db.prepare(`INSERT INTO training_feedback(
      feedback_id,training_session_id,session_exercise_id,
      source_provider,source_chat_id,source_message_id,raw_text,created_at
    ) VALUES(?,?,?,NULL,NULL,NULL,?,?)`).run(
      feedbackId, params.training_session_id, params.session_exercise_id ?? null, text, now
    );
    return one<Row>(db, "SELECT * FROM training_feedback WHERE feedback_id=?", feedbackId);
  });
}

export function recordObservation(
  db: DatabaseSync,
  params: {
    kind: string;
    subject_type: string;
    subject_id?: string | null;
    statement: string;
    structured_value?: Record<string, unknown>;
    persistence_class: "SITUATIONAL" | "POTENTIALLY_PERSISTENT" | "EXPLICITLY_PERSISTENT";
    source_type: "USER_CHAT" | "PERFORMANCE" | "AGENT_ANALYSIS" | "MIGRATION";
    source_feedback_id?: string | null;
    source_session_id?: string | null;
    observed_at?: string;
  }
) {
  return withTransaction(db, () => {
    const statement = params.statement.trim();
    if (!statement || statement.length > 4000) throw new Error("Invalid observation statement");
    if (params.source_type === "USER_CHAT" && !params.source_feedback_id) {
      throw new Error("USER_CHAT observation requires source feedback provenance");
    }
    if (params.source_feedback_id) {
      const feedback = one<{training_session_id:string}>(
        db,
        "SELECT training_session_id FROM training_feedback WHERE feedback_id=?",
        params.source_feedback_id
      );
      if (!feedback) throw new Error("Observation source feedback not found");
      if (params.source_session_id && feedback.training_session_id !== params.source_session_id) {
        throw new Error("Observation feedback/session provenance mismatch");
      }
    }
    if (params.source_session_id) {
      const session = one(
        db,
        "SELECT training_session_id FROM training_sessions WHERE training_session_id=?",
        params.source_session_id
      );
      if (!session) throw new Error("Observation source session not found");
    }
    const observationId = newId("obs");
    const now = nowIso();
    db.prepare(`INSERT INTO observations(
      observation_id,kind,subject_type,subject_id,statement,structured_value_json,persistence_class,
      source_type,source_feedback_id,source_session_id,observed_at,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?)`).run(
      observationId, params.kind, params.subject_type, params.subject_id ?? null, statement,
      JSON.stringify(params.structured_value ?? {}), params.persistence_class, params.source_type,
      params.source_feedback_id ?? null, params.source_session_id ?? null,
      params.observed_at ?? now, now
    );
    return one<Row>(db, "SELECT * FROM observations WHERE observation_id=?", observationId);
  });
}

export function upsertLearnedItem(
  db: DatabaseSync,
  params: {
    learned_item_id?: string;
    kind: string;
    subject_type: string;
    subject_id?: string | null;
    statement: string;
    value?: Record<string, unknown>;
    status: "HYPOTHESIS" | "ACTIVE" | "SUPERSEDED" | "REJECTED";
    promotion_basis?: string | null;
    evidence: Array<{ observation_id: string; relation: "SUPPORTS" | "CONTRADICTS" }>;
  }
) {
  return withTransaction(db, () => {
    if (!params.evidence.length) throw new Error("Learned item requires evidence");
    const evidenceRows = params.evidence.map((item) => {
      const observation = one<{
        observation_id:string;
        source_type:string;
        persistence_class:string;
        status:string;
      }>(
        db,
        "SELECT observation_id,source_type,persistence_class,status FROM observations WHERE observation_id=?",
        item.observation_id
      );
      if (!observation || observation.status !== "ACTIVE") {
        throw new Error(`Learning evidence unavailable: ${item.observation_id}`);
      }
      return {
        ...item,
        source_type: observation.source_type,
        persistence_class: observation.persistence_class,
      };
    });
    if (params.status === "ACTIVE") {
      const explicitUserSupport = evidenceRows.some((item) =>
        item.relation === "SUPPORTS" &&
        item.source_type === "USER_CHAT" &&
        item.persistence_class === "EXPLICITLY_PERSISTENT"
      );
      const migratedDurableSupport = evidenceRows.some((item) =>
        item.relation === "SUPPORTS" &&
        item.source_type === "MIGRATION" &&
        item.persistence_class === "EXPLICITLY_PERSISTENT"
      );
      if (!explicitUserSupport && !migratedDurableSupport) {
        throw new Error(
          "ACTIVE learning requires explicit persistent user evidence; inferred performance remains HYPOTHESIS"
        );
      }
    }

    const now = nowIso();
    const id = params.learned_item_id ?? newId("learn");
    const existing = one<Row>(db, "SELECT * FROM learned_items WHERE learned_item_id=?", id);
    const statement = params.statement.trim();
    if (!statement || statement.length > 4000) throw new Error("Invalid learned-item statement");

    if (existing) {
      db.prepare(`UPDATE learned_items
        SET kind=?,subject_type=?,subject_id=?,statement=?,value_json=?,status=?,
            promotion_basis=?,updated_at=?,last_confirmed_at=CASE WHEN ?='ACTIVE' THEN ? ELSE last_confirmed_at END
        WHERE learned_item_id=?`).run(
        params.kind, params.subject_type, params.subject_id ?? null, statement,
        JSON.stringify(params.value ?? {}), params.status, params.promotion_basis ?? null,
        now, params.status, now, id
      );
      db.prepare("DELETE FROM learning_evidence WHERE learned_item_id=?").run(id);
    } else {
      db.prepare(`INSERT INTO learned_items(
        learned_item_id,kind,subject_type,subject_id,statement,value_json,status,promotion_basis,
        created_at,updated_at,last_confirmed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, params.kind, params.subject_type, params.subject_id ?? null, statement,
        JSON.stringify(params.value ?? {}), params.status, params.promotion_basis ?? null,
        now, now, params.status === "ACTIVE" ? now : null
      );
    }

    const insert = db.prepare(
      "INSERT INTO learning_evidence(learned_item_id,observation_id,relation,created_at) VALUES(?,?,?,?)"
    );
    for (const item of params.evidence) insert.run(id, item.observation_id, item.relation, now);

    return {
      item: one<Row>(db, "SELECT * FROM learned_items WHERE learned_item_id=?", id),
      evidence: all<Row>(
        db,
        `SELECT le.observation_id,le.relation,o.source_type,o.statement
           FROM learning_evidence le JOIN observations o ON o.observation_id=le.observation_id
          WHERE le.learned_item_id=? ORDER BY le.created_at,o.observation_id`,
        id
      ),
    };
  });
}

export function getRelevantLearning(
  db: DatabaseSync,
  params: { subject_type: string; subject_id?: string | null; include_hypotheses?: boolean }
) {
  return all<Row>(
    db,
    `SELECT li.*,
            (SELECT count(*) FROM learning_evidence le WHERE le.learned_item_id=li.learned_item_id AND le.relation='SUPPORTS') AS supporting_evidence_count,
            (SELECT count(*) FROM learning_evidence le WHERE le.learned_item_id=li.learned_item_id AND le.relation='CONTRADICTS') AS contradicting_evidence_count
       FROM learned_items li
      WHERE li.subject_type=?
        AND ((? IS NULL AND li.subject_id IS NULL) OR li.subject_id=?)
        AND li.status IN (${params.include_hypotheses ? "'ACTIVE','HYPOTHESIS'" : "'ACTIVE'"})
      ORDER BY CASE li.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,li.updated_at DESC`,
    params.subject_type, params.subject_id ?? null, params.subject_id ?? null
  );
}

