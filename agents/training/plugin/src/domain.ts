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

  const conditioning = slot.workout_kind === "CONDITIONING" ? one(
    db,
    "SELECT * FROM conditioning_policies WHERE workout_template_id=?",
    slot.workout_template_id
  ) : undefined;

  return {
    active_program: { ...active, cycle_number: cursor.cycle_number },
    recommendation: { ...slot, exercises, conditioning: conditioning ?? null },
  };
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
      const template = all<{template_exercise_id:string; exercise_id:string; sequence:number}>(
        db,
        "SELECT template_exercise_id,exercise_id,sequence FROM template_exercises WHERE workout_template_id=? ORDER BY sequence",
        selected.workout_template_id
      );
      const insert = db.prepare(`INSERT INTO session_exercises(
        session_exercise_id,training_session_id,template_exercise_id,exercise_id,sequence,status
      ) VALUES(?,?,?,?,?,'PENDING')`);
      for (const item of template) {
        insert.run(newId("sex"), sessionId, item.template_exercise_id, item.exercise_id, item.sequence);
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

