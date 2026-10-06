import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  abandonSession,
  applyApprovedProgramChange,
  completeConditioning,
  completeExercise,
  correctSetResult,
  createConditioningPrescription,
  deferExercise,
  finishSession,
  getProgressionCandidate,
  getProgramState,
  getRecommendation,
  getSession,
  pauseSession,
  prescribeExercise,
  proposeProgramChange,
  recordObservation,
  recordTrainingFeedback,
  restartProgramCycle,
  resumeExercise,
  searchExercises,
  skipExercise,
  resumeSession,
  startAdHocSession,
  startProgramSession,
  substituteExercise,
  upsertLearnedItem,
  voidSession,
} from "./domain.js";
import { nowIso, openTrainingStore } from "./store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "training-domain-"));
  roots.push(root);
  const db = openTrainingStore(path.join(root, "training.sqlite3"));
  const now = nowIso();

  const program = "prog_test";
  const version = "ver_test";
  db.prepare("INSERT INTO programs VALUES(?,?,?,?)")
    .run(program, "Test", "Test objective", now);
  db.prepare("INSERT INTO program_versions VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(version, program, 1, "ACTIVE", "{}", "MIGRATION", null, now, null, now);

  for (const [id, name] of [["ex_a", "Squat"], ["ex_b", "Press"]] as const) {
    db.prepare("INSERT INTO exercises VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        id, name, "strength", "barbell",
        "TOTAL_EXTERNAL", "TOTAL", "HIGHER_IS_HARDER", 1, now,
      );
  }

  const templates = [
    ["tpl_a", "Strength A", "STRENGTH"],
    ["tpl_cond", "Conditioning", "CONDITIONING"],
    ["tpl_b", "Strength B", "STRENGTH"],
    ["tpl_c", "Strength C", "STRENGTH"],
  ] as const;
  for (const [id, name, kind] of templates) {
    db.prepare("INSERT INTO workout_templates VALUES(?,?,?,?,?)")
      .run(id, version, name, kind, null);
  }

  const slots = [
    ["slot_a", 1, "tpl_a"],
    ["slot_cond_1", 2, "tpl_cond"],
    ["slot_b", 3, "tpl_b"],
    ["slot_cond_2", 4, "tpl_cond"],
    ["slot_c", 5, "tpl_c"],
  ] as const;
  for (const [id, sequence, template] of slots) {
    db.prepare("INSERT INTO program_slots VALUES(?,?,?,?)")
      .run(id, version, sequence, template);
  }
  db.prepare("INSERT INTO program_cursor VALUES(?,?,?,?)")
    .run(version, 1, "slot_a", now);

  db.prepare("INSERT INTO template_exercises VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("te_a", "tpl_a", "ex_a", 1, 4, 6, 6, 2, 2, null, null, "{}", null);
  db.prepare("INSERT INTO template_exercises VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("te_b", "tpl_b", "ex_b", 1, 4, 6, 6, 2, 2, null, null, "{}", null);

  for (const [id, name] of [["bike", "Bike"], ["treadmill", "Treadmill"], ["swim", "Swim"]] as const) {
    db.prepare("INSERT INTO conditioning_modalities VALUES(?,?,1)").run(id, name);
  }
  db.prepare("INSERT INTO conditioning_policies VALUES(?,?,?,?,?,?,?)")
    .run("cp_base", "tpl_cond", "aerobic base", 1800, 2400, "HR_ZONE", null);
  for (const modality of ["bike", "treadmill", "swim"]) {
    db.prepare("INSERT INTO conditioning_policy_modalities VALUES(?,?)")
      .run("cp_base", modality);
  }

  return db;
}

function fourSets(load = 40) {
  return [1, 2, 3, 4].map((set_number) => ({
    set_number,
    candidate_reps: 6,
    candidate_load_kg: load,
    candidate_rir: 2,
    target_reps: 6,
    target_load_kg: load,
    target_rir: 2,
  }));
}

describe("TRA-SEL / TRA-STR deterministic core", () => {
  it("TRA-SEL-001: recommendation read does not create a session", () => {
    const db = fixture();
    try {
      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_a");
      const count = Number((db.prepare("SELECT count(*) n FROM training_sessions").get() as { n:number }).n);
      expect(count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("TRA-SEL-003/004: forward override advances only after completion", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        selected_program_slot_id: "slot_b",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      expect(started.replayed).toBe(false);
      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_a");

      const exercise = started.session.exercises[0];
      prescribeExercise(db, exercise.session_exercise_id, fourSets());
      completeExercise(db, exercise.session_exercise_id, "AS_PRESCRIBED");
      finishSession(db, started.session.training_session_id);

      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_cond_2");
      const outcomes = db.prepare(
        "SELECT program_slot_id,outcome FROM program_slot_outcomes ORDER BY rowid"
      ).all() as Array<{program_slot_id:string; outcome:string}>;
      expect(outcomes.map((x) => [x.program_slot_id, x.outcome])).toEqual([
        ["slot_a", "SKIPPED_FORWARD_OVERRIDE"],
        ["slot_cond_1", "SKIPPED_FORWARD_OVERRIDE"],
        ["slot_b", "COMPLETED"],
      ]);
    } finally {
      db.close();
    }
  });

  it("TRA-STR-001/002: same prescription replays and a different one fails", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const id = started.session.exercises[0].session_exercise_id;
      expect(prescribeExercise(db, id, fourSets(70)).replayed).toBe(false);
      expect(prescribeExercise(db, id, fourSets(70)).replayed).toBe(true);
      expect(() => prescribeExercise(db, id, fourSets(72.5)))
        .toThrow(/different durable prescription/);
    } finally {
      db.close();
    }
  });

  it("TRA-STR-002: persisted prescription survives SQLite close/reopen unchanged", () => {
    let db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const id = started.session.exercises[0].session_exercise_id;
      const prescription = fourSets(70);
      prescribeExercise(db, id, prescription);
      const dbFile = (db.prepare("PRAGMA database_list").all() as any[])
        .find((row) => row.name === "main").file as string;
      db.close();
      db = openTrainingStore(dbFile);
      const restored: any = getSession(db, started.session.training_session_id);
      expect(restored.exercises[0].sets).toHaveLength(4);
      expect(restored.exercises[0].sets.every((set: any) => set.target_load_kg === 70)).toBe(true);
      expect(prescribeExercise(db, id, prescription).replayed).toBe(true);
      expect(() => prescribeExercise(db, id, fourSets(72.5)))
        .toThrow(/different durable prescription/);
    } finally {
      db.close();
    }
  });

  it("timed/distance working sets preserve NULL reps and copy targets exactly", () => {
    const db = fixture();
    try {
      const started: any = startAdHocSession(db, {
        session_kind: "STRENGTH",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
        strength_exercises: [{
          exercise_id: "ex_a",
          planned_sets: 2,
          target_reps_min: null,
          target_reps_max: null,
          target_rir_min: null,
          target_rir_max: null,
          target_duration_sec: null,
          target_distance_m: null,
        }],
      });
      const id = started.session.exercises[0].session_exercise_id;
      prescribeExercise(db, id, [
        {
          set_number: 1,
          candidate_reps: null,
          candidate_load_kg: null,
          candidate_rir: null,
          candidate_duration_sec: 30,
          candidate_distance_m: null,
          target_reps: null,
          target_load_kg: null,
          target_rir: null,
          target_duration_sec: 30,
          target_distance_m: null,
        },
        {
          set_number: 2,
          candidate_reps: null,
          candidate_load_kg: 32,
          candidate_rir: null,
          candidate_duration_sec: null,
          candidate_distance_m: 40,
          target_reps: null,
          target_load_kg: 32,
          target_rir: null,
          target_duration_sec: null,
          target_distance_m: 40,
        },
      ]);
      completeExercise(db, id, "AS_PRESCRIBED");
      const rows = db.prepare(
        `SELECT actual_reps,actual_load_kg,actual_rir,actual_duration_sec,actual_distance_m
           FROM session_sets WHERE session_exercise_id=? ORDER BY set_number`
      ).all(id) as any[];
      expect(rows).toEqual([
        { actual_reps: null, actual_load_kg: null, actual_rir: null, actual_duration_sec: 30, actual_distance_m: null },
        { actual_reps: null, actual_load_kg: 32, actual_rir: null, actual_duration_sec: null, actual_distance_m: 40 },
      ]);
    } finally {
      db.close();
    }
  });

  it("TRA-STR-003: AS_PRESCRIBED copies targets to actuals", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const id = started.session.exercises[0].session_exercise_id;
      prescribeExercise(db, id, fourSets(70));
      completeExercise(db, id, "AS_PRESCRIBED");
      const sets = db.prepare(
        "SELECT target_reps,target_load_kg,target_rir,actual_reps,actual_load_kg,actual_rir,status FROM session_sets WHERE session_exercise_id=? ORDER BY set_number"
      ).all(id) as any[];
      expect(sets.every((set) =>
        set.status === "COMPLETED"
        && set.target_reps === set.actual_reps
        && set.target_load_kg === set.actual_load_kg
        && set.target_rir === set.actual_rir
      )).toBe(true);
    } finally {
      db.close();
    }
  });

  it("TRA-VAL-006: obvious 700-vs-70 anomaly fails before commit", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const id = started.session.exercises[0].session_exercise_id;
      prescribeExercise(db, id, [{
        set_number: 1,
        candidate_reps: 6,
        candidate_load_kg: 70,
        candidate_rir: 2,
        target_reps: 6,
        target_load_kg: 70,
        target_rir: 2,
      }]);
      expect(() => completeExercise(db, id, "ACTUALS", [{
        set_number: 1,
        reps: 6,
        load_kg: 700,
        rir: 2,
      }])).toThrow(/SUSPICIOUS load/);

      const row = db.prepare(
        "SELECT status,actual_load_kg FROM session_sets WHERE session_exercise_id=?"
      ).get(id) as any;
      expect(row.status).toBe("PLANNED");
      expect(row.actual_load_kg).toBeNull();
    } finally {
      db.close();
    }
  });

  it("TRA-LIFE-001/002: pause and resume preserve the cursor and pause interval", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      pauseSession(db, started.session.training_session_id);
      expect((db.prepare("SELECT status FROM training_sessions WHERE training_session_id=?")
        .get(started.session.training_session_id) as any).status).toBe("PAUSED");
      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_a");

      resumeSession(db, started.session.training_session_id);
      const pause = db.prepare(
        "SELECT paused_at,resumed_at FROM training_session_pauses WHERE training_session_id=?"
      ).get(started.session.training_session_id) as any;
      expect(pause.paused_at).toBeTruthy();
      expect(pause.resumed_at).toBeTruthy();
      expect((db.prepare("SELECT status FROM training_sessions WHERE training_session_id=?")
        .get(started.session.training_session_id) as any).status).toBe("ACTIVE");
    } finally {
      db.close();
    }
  });

  it("TRA-STR-007: a deferred exercise can resume without losing its prescription", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const id = started.session.exercises[0].session_exercise_id;
      prescribeExercise(db, id, fourSets(70));
      deferExercise(db, id);
      const resumed: any = resumeExercise(db, id);
      expect(resumed.exercise.status).toBe("ACTIVE");
      expect(resumed.exercise.sets).toHaveLength(4);
      expect(resumed.exercise.sets.every((x: any) => x.target_load_kg === 70)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("TRA-LIFE-004: abandoned session preserves cursor and closes unfinished work", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const id = started.session.exercises[0].session_exercise_id;
      prescribeExercise(db, id, fourSets(70));
      abandonSession(db, started.session.training_session_id, "had to leave");
      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_a");
      const session = db.prepare("SELECT status FROM training_sessions WHERE training_session_id=?")
        .get(started.session.training_session_id) as any;
      expect(session.status).toBe("ABANDONED");
      const exercise = db.prepare("SELECT status FROM session_exercises WHERE session_exercise_id=?").get(id) as any;
      expect(exercise.status).toBe("SKIPPED");
    } finally {
      db.close();
    }
  });

  it("TRA-VAL-008: correction updates the authoritative value and preserves audit", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const exerciseId = started.session.exercises[0].session_exercise_id;
      prescribeExercise(db, exerciseId, fourSets(70));
      completeExercise(db, exerciseId, "AS_PRESCRIBED");
      const set = db.prepare(
        "SELECT session_set_id FROM session_sets WHERE session_exercise_id=? AND set_number=2"
      ).get(exerciseId) as any;
      correctSetResult(db, set.session_set_id, { load_kg: 67.5 }, "user correction");
      const corrected = db.prepare(
        "SELECT actual_load_kg FROM session_sets WHERE session_set_id=?"
      ).get(set.session_set_id) as any;
      expect(corrected.actual_load_kg).toBe(67.5);
      const audit = db.prepare(
        "SELECT previous_value_json,corrected_value_json FROM data_corrections WHERE target_id=?"
      ).get(set.session_set_id) as any;
      expect(JSON.parse(audit.previous_value_json)).toBe(70);
      expect(JSON.parse(audit.corrected_value_json)).toBe(67.5);
    } finally {
      db.close();
    }
  });

  it("TRA-SEL-005: repeating an earlier slot does not overwrite its original program outcome", () => {
    const db = fixture();
    try {
      const first: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const firstExercise = first.session.exercises[0].session_exercise_id;
      prescribeExercise(db, firstExercise, fourSets(70));
      completeExercise(db, firstExercise, "AS_PRESCRIBED");
      finishSession(db, first.session.training_session_id);
      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_cond_1");

      const repeated: any = startProgramSession(db, {
        selected_program_slot_id: "slot_a",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-07",
      });
      const repeatedExercise = repeated.session.exercises[0].session_exercise_id;
      prescribeExercise(db, repeatedExercise, fourSets(70));
      completeExercise(db, repeatedExercise, "AS_PRESCRIBED");
      finishSession(db, repeated.session.training_session_id);

      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_cond_1");
      const outcomes = db.prepare(
        "SELECT training_session_id FROM program_slot_outcomes WHERE program_slot_id='slot_a'"
      ).all() as any[];
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].training_session_id).toBe(first.session.training_session_id);
    } finally {
      db.close();
    }
  });


  it("calculates progression from two successful comparable exposures", () => {
    const db = fixture();
    try {
      db.prepare(
        "UPDATE template_exercises SET progression_policy_json=? WHERE template_exercise_id='te_a'"
      ).run(JSON.stringify({
        kind: "DOUBLE_SUCCESS_THEN_INCREMENT",
        initial_load_kg: 70,
        increment_kg: 2.5,
        successful_exposures_required: 2,
      }));

      const first: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      let id = first.session.exercises[0].session_exercise_id;
      expect(getProgressionCandidate(db, id).candidate_load_kg).toBe(70);
      prescribeExercise(db, id, fourSets(70));
      completeExercise(db, id, "AS_PRESCRIBED");
      finishSession(db, first.session.training_session_id);

      const second: any = startProgramSession(db, {
        selected_program_slot_id: "slot_a",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-07",
      });
      id = second.session.exercises[0].session_exercise_id;
      prescribeExercise(db, id, fourSets(70));
      completeExercise(db, id, "AS_PRESCRIBED");
      finishSession(db, second.session.training_session_id);

      const third: any = startProgramSession(db, {
        selected_program_slot_id: "slot_a",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-08",
      });
      id = third.session.exercises[0].session_exercise_id;
      const candidate = getProgressionCandidate(db, id);
      expect(candidate.candidate_load_kg).toBe(72.5);
      expect(candidate.basis).toBe("SUCCESS_STREAK_INCREMENT");
      expect(candidate.recent_exposures.slice(0, 2).every((x) => x.success)).toBe(true);
    } finally {
      db.close();
    }
  });


  it("TRA-CON-002/005: modality override stays in the Conditioning slot and Fitbit is not required", () => {
    const db = fixture();
    try {
      const strength: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const strengthExercise = strength.session.exercises[0].session_exercise_id;
      prescribeExercise(db, strengthExercise, fourSets(70));
      completeExercise(db, strengthExercise, "AS_PRESCRIBED");
      finishSession(db, strength.session.training_session_id);
      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_cond_1");

      const conditioning: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-07",
      });
      const prescription: any = createConditioningPrescription(db, {
        training_session_id: conditioning.session.training_session_id,
        recommended_modality_id: "bike",
        selected_modality_id: "treadmill",
        modality_selection_source: "USER_OVERRIDE",
        protocol_summary: "35 min Zone 2",
        segments: [
          { sequence: 1, segment_type: "WARMUP", target_duration_sec: 300 },
          { sequence: 2, segment_type: "WORK", target_duration_sec: 1500, target_hr_zone: 2 },
          { sequence: 3, segment_type: "COOLDOWN", target_duration_sec: 300 },
        ],
      });
      expect(prescription.prescription.recommended_modality_id).toBe("bike");
      expect(prescription.prescription.selected_modality_id).toBe("treadmill");
      completeConditioning(db, {
        conditioning_prescription_id: prescription.prescription.conditioning_prescription_id,
        mode: "AS_PRESCRIBED",
      });
      finishSession(db, conditioning.session.training_session_id);
      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_b");
      const result = db.prepare(
        "SELECT actual_duration_sec FROM conditioning_results WHERE conditioning_prescription_id=?"
      ).get(prescription.prescription.conditioning_prescription_id) as any;
      expect(result.actual_duration_sec).toBe(2100);
      const telemetry = Number((db.prepare(
        "SELECT count(*) n FROM external_telemetry_links WHERE training_session_id=?"
      ).get(conditioning.session.training_session_id) as any).n);
      expect(telemetry).toBe(0);
    } finally {
      db.close();
    }
  });

  it("blocks Conditioning session completion until a Conditioning result exists", () => {
    const db = fixture();
    try {
      const adHoc: any = startAdHocSession(db, {
        session_kind: "CONDITIONING",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      createConditioningPrescription(db, {
        training_session_id: adHoc.session.training_session_id,
        selected_modality_id: "bike",
        modality_selection_source: "USER_AD_HOC",
        protocol_summary: "20 min easy",
        segments: [{ sequence: 1, segment_type: "WORK", target_duration_sec: 1200 }],
      });
      expect(() => finishSession(db, adHoc.session.training_session_id))
        .toThrow(/Conditioning result must be recorded/);
      const state = db.prepare(
        "SELECT status FROM training_sessions WHERE training_session_id=?"
      ).get(adHoc.session.training_session_id) as any;
      expect(state.status).toBe("ACTIVE");
      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_a");
    } finally {
      db.close();
    }
  });

  it("TRA-SEL-006: ad-hoc Conditioning does not move the program cursor", () => {
    const db = fixture();
    try {
      const before = getRecommendation(db).recommendation?.program_slot_id;
      const adHoc: any = startAdHocSession(db, {
        session_kind: "CONDITIONING",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const prescription: any = createConditioningPrescription(db, {
        training_session_id: adHoc.session.training_session_id,
        selected_modality_id: "swim",
        modality_selection_source: "USER_AD_HOC",
        protocol_summary: "30 min swim",
        segments: [{ sequence: 1, segment_type: "WORK", target_duration_sec: 1800 }],
      });
      completeConditioning(db, {
        conditioning_prescription_id: prescription.prescription.conditioning_prescription_id,
        mode: "AS_PRESCRIBED",
      });
      finishSession(db, adHoc.session.training_session_id);
      expect(getRecommendation(db).recommendation?.program_slot_id).toBe(before);
    } finally {
      db.close();
    }
  });


  it("TRA-PROG-001/002/004: approved proposal creates a new immutable version starting at Strength A", () => {
    const db = fixture();
    try {
      const proposal: any = proposeProgramChange(db, {
        change_type: "REPLACE_EXERCISE",
        proposal: {
          template_exercise_id: "te_a",
          replacement_exercise_id: "ex_b",
        },
        rationale: "user-approved replacement",
      });
      expect(proposal.status).toBe("PENDING");
      expect((db.prepare("SELECT program_version_id FROM program_versions WHERE status='ACTIVE'").get() as any)
        .program_version_id).toBe("ver_test");

      const applied: any = applyApprovedProgramChange(db, proposal.proposal_id, "USER");
      expect(applied.active_program.version_number).toBe(2);
      expect(getRecommendation(db).recommendation?.name).toBe("Strength A");
      expect(getRecommendation(db).active_program?.cycle_number).toBe(1);

      const oldExercise = (db.prepare(
        "SELECT exercise_id FROM template_exercises WHERE template_exercise_id='te_a'"
      ).get() as any).exercise_id;
      expect(oldExercise).toBe("ex_a");

      const newExercise = db.prepare(
        `SELECT te.exercise_id
           FROM template_exercises te
           JOIN workout_templates wt ON wt.workout_template_id=te.workout_template_id
           JOIN program_versions pv ON pv.program_version_id=wt.program_version_id
          WHERE pv.status='ACTIVE' AND wt.name='Strength A' AND te.sequence=1`
      ).get() as any;
      expect(newExercise.exercise_id).toBe("ex_b");
      expect((db.prepare(
        "SELECT status FROM program_versions WHERE program_version_id='ver_test'"
      ).get() as any).status).toBe("RETIRED");
    } finally {
      db.close();
    }
  });

  it("TRA-PROG-005: program version cannot change while a session is open", () => {
    const db = fixture();
    try {
      const proposal: any = proposeProgramChange(db, {
        change_type: "UPDATE_EXERCISE_TARGETS",
        proposal: { template_exercise_id: "te_a", target_sets: 3 },
        rationale: "test",
      });
      startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      expect(() => applyApprovedProgramChange(db, proposal.proposal_id, "USER"))
        .toThrow(/while a session is open/);
      expect((db.prepare("SELECT count(*) n FROM program_versions").get() as any).n).toBe(1);
    } finally {
      db.close();
    }
  });


  it("TRA-LRN-003: explicitly persistent user feedback can become ACTIVE learning", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const feedback: any = recordTrainingFeedback(db, {
        training_session_id: started.session.training_session_id,
        raw_text: "Я вообще не люблю Pec Deck",
      });
      const observation: any = recordObservation(db, {
        kind: "EXERCISE_PREFERENCE",
        subject_type: "EXERCISE",
        subject_id: "ex_a",
        statement: "User explicitly dislikes this exercise",
        persistence_class: "EXPLICITLY_PERSISTENT",
        source_type: "USER_CHAT",
        source_feedback_id: feedback.feedback_id,
        source_session_id: started.session.training_session_id,
      });
      const learned: any = upsertLearnedItem(db, {
        kind: "EXERCISE_PREFERENCE",
        subject_type: "EXERCISE",
        subject_id: "ex_a",
        statement: "User dislikes this exercise",
        status: "ACTIVE",
        evidence: [{
          observation_id: observation.observation_id,
          relation: "SUPPORTS",
        }],
      });
      expect(learned.item.status).toBe("ACTIVE");
      expect(learned.evidence).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("TRA-LRN-002/004: situational or performance inference cannot auto-promote to ACTIVE", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const feedback: any = recordTrainingFeedback(db, {
        training_session_id: started.session.training_session_id,
        raw_text: "Сегодня не хочу приседать",
      });
      const situational: any = recordObservation(db, {
        kind: "EXERCISE_PREFERENCE",
        subject_type: "EXERCISE",
        subject_id: "ex_a",
        statement: "User does not want this exercise today",
        persistence_class: "SITUATIONAL",
        source_type: "USER_CHAT",
        source_feedback_id: feedback.feedback_id,
        source_session_id: started.session.training_session_id,
      });
      expect(() => upsertLearnedItem(db, {
        kind: "EXERCISE_PREFERENCE",
        subject_type: "EXERCISE",
        subject_id: "ex_a",
        statement: "User dislikes this exercise",
        status: "ACTIVE",
        evidence: [{
          observation_id: situational.observation_id,
          relation: "SUPPORTS",
        }],
      })).toThrow(/explicit persistent user evidence/);

      const performance: any = recordObservation(db, {
        kind: "ADHERENCE_PATTERN",
        subject_type: "PROGRAM",
        subject_id: "prog_test",
        statement: "User shortened one observed session",
        persistence_class: "POTENTIALLY_PERSISTENT",
        source_type: "PERFORMANCE",
        source_session_id: started.session.training_session_id,
      });
      expect(() => upsertLearnedItem(db, {
        kind: "ADHERENCE_PATTERN",
        subject_type: "PROGRAM",
        subject_id: "prog_test",
        statement: "User tends to shorten sessions",
        status: "ACTIVE",
        evidence: [{
          observation_id: performance.observation_id,
          relation: "SUPPORTS",
        }],
      })).toThrow(/explicit persistent user evidence/);

      const hypothesis: any = upsertLearnedItem(db, {
        kind: "ADHERENCE_PATTERN",
        subject_type: "PROGRAM",
        subject_id: "prog_test",
        statement: "User may tend to shorten sessions",
        status: "HYPOTHESIS",
        evidence: [{
          observation_id: performance.observation_id,
          relation: "SUPPORTS",
        }],
      });
      expect(hypothesis.item.status).toBe("HYPOTHESIS");
    } finally {
      db.close();
    }
  });

  it("TRA-LRN-006: agent analysis alone cannot self-confirm ACTIVE learning", () => {
    const db = fixture();
    try {
      const observation: any = recordObservation(db, {
        kind: "AGENT_HYPOTHESIS",
        subject_type: "PROGRAM",
        subject_id: "prog_test",
        statement: "Agent thinks Friday sessions may be harder",
        persistence_class: "POTENTIALLY_PERSISTENT",
        source_type: "AGENT_ANALYSIS",
      });
      expect(() => upsertLearnedItem(db, {
        kind: "AGENT_HYPOTHESIS",
        subject_type: "PROGRAM",
        subject_id: "prog_test",
        statement: "Friday sessions are harder",
        status: "ACTIVE",
        evidence: [{
          observation_id: observation.observation_id,
          relation: "SUPPORTS",
        }],
      })).toThrow(/explicit persistent user evidence/);
    } finally {
      db.close();
    }
  });


  it("TRA-SEL-007 support: program state exposes all ordered slots for deterministic override selection", () => {
    const db = fixture();
    try {
      const state: any = getProgramState(db);
      expect(state.cursor.next_program_slot_id).toBe("slot_a");
      expect(state.slots.map((slot: any) => [slot.sequence, slot.name])).toEqual([
        [1, "Strength A"],
        [2, "Conditioning"],
        [3, "Strength B"],
        [4, "Conditioning"],
        [5, "Strength C"],
      ]);
      expect(state.slots[1].conditioning.modalities.map((x: any) => x.modality_id).sort())
        .toEqual(["bike", "swim", "treadmill"]);
    } finally {
      db.close();
    }
  });

  it("TRA-SEL-007: duplicate Conditioning template resolves to nearest not-yet-passed slot", () => {
    const db1 = fixture();
    try {
      const first: any = startProgramSession(db1, {
        selected_workout_template_id: "tpl_cond",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      expect(first.session.selected_program_slot_id).toBe("slot_cond_1");
      expect(first.session.selection_source).toBe("USER_FORWARD_OVERRIDE");
    } finally {
      db1.close();
    }

    const db2 = fixture();
    try {
      db2.prepare("UPDATE program_cursor SET next_program_slot_id='slot_b' WHERE program_version_id='ver_test'").run();
      const second: any = startProgramSession(db2, {
        selected_workout_template_id: "tpl_cond",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-07",
      });
      expect(second.session.selected_program_slot_id).toBe("slot_cond_2");
      expect(second.session.selection_source).toBe("USER_FORWARD_OVERRIDE");
    } finally {
      db2.close();
    }

    const db3 = fixture();
    try {
      db3.prepare("UPDATE program_cursor SET next_program_slot_id='slot_c' WHERE program_version_id='ver_test'").run();
      expect(() => startProgramSession(db3, {
        selected_workout_template_id: "tpl_cond",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-08",
      })).toThrow(/No unpassed matching Program Slot/);
    } finally {
      db3.close();
    }
  });

  it("TRA-SEL-008: explicit cycle restart starts a new cycle at Strength A", () => {
    const db = fixture();
    try {
      db.prepare("UPDATE program_cursor SET next_program_slot_id='slot_b' WHERE program_version_id='ver_test'").run();
      const restarted: any = restartProgramCycle(db);
      expect(restarted.recommendation.recommendation.program_slot_id).toBe("slot_a");
      const cursor = db.prepare(
        "SELECT cycle_number,next_program_slot_id FROM program_cursor WHERE program_version_id='ver_test'"
      ).get() as any;
      expect(cursor.cycle_number).toBe(2);
      expect(cursor.next_program_slot_id).toBe("slot_a");
    } finally {
      db.close();
    }
  });

  it("TRA-STR-009: session substitution preserves original exercise and does not mutate program", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const id = started.session.exercises[0].session_exercise_id;
      prescribeExercise(db, id, fourSets(70));
      const substituted: any = substituteExercise(db, id, "ex_b", "equipment unavailable");
      expect(substituted.exercise.exercise_id).toBe("ex_b");
      expect(substituted.exercise.substituted_from_exercise_id).toBe("ex_a");
      expect(substituted.exercise.status).toBe("PENDING");
      expect(substituted.exercise.sets).toHaveLength(0);

      const template = db.prepare("SELECT exercise_id FROM template_exercises WHERE template_exercise_id='te_a'").get() as any;
      expect(template.exercise_id).toBe("ex_a");
      const event = db.prepare(
        "SELECT payload_json FROM training_events WHERE event_type='EXERCISE_SUBSTITUTED' AND aggregate_id=?"
      ).get(id) as any;
      expect(JSON.parse(event.payload_json).superseded_prescription).toHaveLength(4);
    } finally {
      db.close();
    }
  });

  it("exercise search resolves the canonical catalog for ad-hoc and substitution flows", () => {
    const db = fixture();
    try {
      db.prepare("INSERT INTO exercise_aliases VALUES('alias_press','ex_b','OHP')").run();
      expect((searchExercises(db, "press") as any[]).map((x) => x.exercise_id)).toContain("ex_b");
      expect((searchExercises(db, "ohp") as any[]).map((x) => x.exercise_id)).toEqual(["ex_b"]);
    } finally {
      db.close();
    }
  });


  it("TRA-SEL-002/009: accepting recommendation creates one session and a paused session blocks a second start", () => {
    const db = fixture();
    try {
      const first: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      expect(first.session.selected_program_slot_id).toBe("slot_a");
      expect(Number((db.prepare("SELECT count(*) n FROM training_sessions").get() as any).n)).toBe(1);
      pauseSession(db, first.session.training_session_id);
      const second: any = startProgramSession(db, {
        selected_program_slot_id: "slot_b",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      expect(second.replayed).toBe(true);
      expect(second.session.training_session_id).toBe(first.session.training_session_id);
      expect(Number((db.prepare("SELECT count(*) n FROM training_sessions").get() as any).n)).toBe(1);
      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_a");
    } finally {
      db.close();
    }
  });

  it("TRA-STR-004/005 and TRA-VAL-005/007: actual deviations validate atomically and corrected typo can be committed", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const id = started.session.exercises[0].session_exercise_id;
      const sets = fourSets(70);
      prescribeExercise(db, id, sets);

      expect(() => completeExercise(db, id, "ACTUALS", [{
        set_number: 1,
        reps: 6,
        load_kg: 70,
        rir: 2,
      }])).toThrow(/set count/);
      expect(() => completeExercise(db, id, "ACTUALS", [
        { set_number: 1, reps: -1, load_kg: 70, rir: 2 },
        { set_number: 2, reps: 6, load_kg: 70, rir: 2 },
        { set_number: 3, reps: 6, load_kg: 70, rir: 2 },
        { set_number: 4, reps: 6, load_kg: 70, rir: 2 },
      ])).toThrow(/INVALID reps/);
      expect(() => completeExercise(db, id, "ACTUALS", [
        { set_number: 1, reps: 6, load_kg: 700, rir: 2 },
        { set_number: 2, reps: 6, load_kg: 70, rir: 2 },
        { set_number: 3, reps: 6, load_kg: 70, rir: 2 },
        { set_number: 4, reps: 6, load_kg: 70, rir: 2 },
      ])).toThrow(/SUSPICIOUS load/);

      const afterFailures = db.prepare(
        "SELECT count(*) n FROM session_sets WHERE session_exercise_id=? AND status='COMPLETED'"
      ).get(id) as any;
      expect(Number(afterFailures.n)).toBe(0);

      completeExercise(db, id, "ACTUALS", [
        { set_number: 1, reps: 6, load_kg: 70, rir: 2 },
        { set_number: 2, reps: 6, load_kg: 70, rir: 2 },
        { set_number: 3, reps: 6, load_kg: 70, rir: 2 },
        { set_number: 4, reps: 5, load_kg: 70, rir: 0 },
      ]);
      const actual = db.prepare(
        "SELECT actual_reps,actual_load_kg,actual_rir FROM session_sets WHERE session_exercise_id=? ORDER BY set_number"
      ).all(id) as any[];
      expect(actual[3]).toMatchObject({ actual_reps: 5, actual_load_kg: 70, actual_rir: 0 });
    } finally {
      db.close();
    }
  });

  it("TRA-STR-006/008 and TRA-LIFE-003: defer/skip and completed-partial advance cursor explicitly", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const id = started.session.exercises[0].session_exercise_id;
      prescribeExercise(db, id, fourSets(70));
      deferExercise(db, id);
      expect((db.prepare("SELECT status FROM session_exercises WHERE session_exercise_id=?").get(id) as any).status)
        .toBe("DEFERRED");
      skipExercise(db, id, "user skipped");
      expect(Number((db.prepare(
        "SELECT count(*) n FROM session_sets WHERE session_exercise_id=? AND status='SKIPPED'"
      ).get(id) as any).n)).toBe(4);
      finishSession(db, started.session.training_session_id);
      expect(getRecommendation(db).recommendation?.program_slot_id).toBe("slot_cond_1");
      const outcome = db.prepare(
        "SELECT outcome FROM program_slot_outcomes WHERE training_session_id=? AND program_slot_id='slot_a'"
      ).get(started.session.training_session_id) as any;
      expect(outcome.outcome).toBe("COMPLETED_PARTIAL");
    } finally {
      db.close();
    }
  });

  it("TRA-LIFE-005: VOIDED session does not block a replacement session or progression history", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const id = started.session.exercises[0].session_exercise_id;
      prescribeExercise(db, id, fourSets(70));
      voidSession(db, started.session.training_session_id, "test session");
      expect((db.prepare("SELECT status FROM training_sessions WHERE training_session_id=?")
        .get(started.session.training_session_id) as any).status).toBe("VOIDED");

      const replacement: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-07",
      });
      expect(replacement.replayed).toBe(false);
      const candidate = getProgressionCandidate(db, replacement.session.exercises[0].session_exercise_id);
      expect(candidate.recent_exposures).toHaveLength(0);
    } finally {
      db.close();
    }
  });


  it("TRA-LIFE-005: VOIDED session feedback cannot become learning evidence", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const feedback: any = recordTrainingFeedback(db, {
        training_session_id: started.session.training_session_id,
        raw_text: "Synthetic feedback from a test session",
      });
      voidSession(db, started.session.training_session_id, "test session");
      expect(() => recordObservation(db, {
        kind: "EXERCISE_PREFERENCE",
        subject_type: "EXERCISE",
        subject_id: "ex_a",
        statement: "Synthetic preference",
        persistence_class: "EXPLICITLY_PERSISTENT",
        source_type: "USER_CHAT",
        source_feedback_id: feedback.feedback_id,
        source_session_id: started.session.training_session_id,
      })).toThrow(/VOIDED session/);
    } finally {
      db.close();
    }
  });

  it("TRA-VAL-001/003: load and repetition semantics remain attached to the canonical exercise", () => {
    const db = fixture();
    try {
      const now = "2026-10-06T07:00:00.000Z";
      db.prepare("INSERT INTO exercises VALUES(?,?,?,?,?,?,?,?,?)").run(
        "ex_dumbbell","Dumbbell Split Squat","strength","dumbbell",
        "PER_HAND","PER_SIDE","HIGHER_IS_HARDER",1,now
      );
      const row = db.prepare(
        "SELECT load_mode,rep_mode,load_progression_direction FROM exercises WHERE exercise_id='ex_dumbbell'"
      ).get() as any;
      expect(row).toEqual({
        load_mode: "PER_HAND",
        rep_mode: "PER_SIDE",
        load_progression_direction: "HIGHER_IS_HARDER",
      });
    } finally {
      db.close();
    }
  });

  it("TRA-VAL-002: assistance progression moves toward lower displayed assistance", () => {
    const db = fixture();
    try {
      const now = "2026-10-06T07:00:00.000Z";
      db.prepare("INSERT INTO exercises VALUES(?,?,?,?,?,?,?,?,?)").run(
        "ex_assist","Assisted Pull-up","strength","machine",
        "ASSISTANCE","TOTAL","LOWER_IS_HARDER",1,now
      );
      db.prepare("INSERT INTO template_exercises VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        "te_assist","tpl_a","ex_assist",2,1,6,6,2,2,null,null,
        JSON.stringify({kind:"DOUBLE_SUCCESS_THEN_INCREMENT",initial_load_kg:40,increment_kg:5,successful_exposures_required:2}),null
      );

      for (const date of ["2026-10-04","2026-10-05"]) {
        const sessionId=`hist_${date}`;
        const sexId=`sex_${date}`;
        db.prepare(`INSERT INTO training_sessions(
          training_session_id,program_version_id,workout_template_id,session_kind,session_source,
          recommended_program_slot_id,selected_program_slot_id,selection_source,
          cursor_before_slot_id,cursor_before_cycle_number,cursor_on_complete_slot_id,cursor_on_complete_cycle_number,
          status,started_at,ended_at,timezone_at_start,local_date,time_precision,overall_feedback,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          sessionId,"ver_test","tpl_a","STRENGTH","PROGRAM","slot_a","slot_a","PROGRAM_RECOMMENDATION",
          "slot_a",1,"slot_cond_1",1,"COMPLETED",`${date}T07:00:00.000Z`,`${date}T08:00:00.000Z`,
          "Europe/Moscow",date,"EXACT",null,`${date}T07:00:00.000Z`
        );
        db.prepare(`INSERT INTO session_exercises(
          session_exercise_id,training_session_id,template_exercise_id,exercise_id,sequence,
          planned_sets,target_reps_min,target_reps_max,target_rir_min,target_rir_max,progression_policy_json,
          status,prescribed_at,started_at,completed_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          sexId,sessionId,"te_assist","ex_assist",1,1,6,6,2,2,
          JSON.stringify({kind:"DOUBLE_SUCCESS_THEN_INCREMENT",initial_load_kg:40,increment_kg:5,successful_exposures_required:2}),
          "COMPLETED",`${date}T07:10:00.000Z`,`${date}T07:10:00.000Z`,`${date}T07:20:00.000Z`
        );
        db.prepare(`INSERT INTO session_sets(
          session_set_id,session_exercise_id,set_number,candidate_reps,candidate_load_kg,candidate_rir,
          target_reps,target_load_kg,target_rir,prescription_reason,actual_reps,actual_load_kg,actual_rir,status
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          `set_${date}`,sexId,1,6,40,2,6,40,2,"test",6,40,2,"COMPLETED"
        );
      }

      const current: any = startAdHocSession(db, {
        session_kind: "STRENGTH",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
        strength_exercises: [{
          exercise_id: "ex_assist",
          planned_sets: 1,
          target_reps_min: 6,
          target_reps_max: 6,
          target_rir_min: 2,
          target_rir_max: 2,
          progression_policy_json: JSON.stringify({kind:"DOUBLE_SUCCESS_THEN_INCREMENT",initial_load_kg:40,increment_kg:5,successful_exposures_required:2}),
        }],
      });
      const candidate = getProgressionCandidate(db, current.session.exercises[0].session_exercise_id);
      expect(candidate.candidate_load_kg).toBe(35);
      expect(candidate.basis).toBe("SUCCESS_STREAK_DECREMENT_ASSISTANCE");
    } finally {
      db.close();
    }
  });

  it("TRA-VAL-004: different machine instances are not used as comparable progression history", () => {
    const db = fixture();
    try {
      const now = "2026-10-06T07:00:00.000Z";
      db.prepare("INSERT INTO equipment_instances VALUES(?,?,?,?,?,?)").run("machine_a","Cable A","Gym","cable",1,now);
      db.prepare("INSERT INTO equipment_instances VALUES(?,?,?,?,?,?)").run("machine_b","Cable B","Gym","cable",1,now);

      const prior: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-05",
      });
      const priorId = prior.session.exercises[0].session_exercise_id;
      db.prepare("UPDATE session_exercises SET equipment_instance_id='machine_a' WHERE session_exercise_id=?").run(priorId);
      prescribeExercise(db, priorId, fourSets(70));
      completeExercise(db, priorId, "AS_PRESCRIBED");
      finishSession(db, prior.session.training_session_id);

      const repeat: any = startProgramSession(db, {
        selected_program_slot_id: "slot_a",
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const currentId = repeat.session.exercises[0].session_exercise_id;
      db.prepare("UPDATE session_exercises SET equipment_instance_id='machine_b' WHERE session_exercise_id=?").run(currentId);
      const candidate = getProgressionCandidate(db, currentId);
      expect(candidate.recent_exposures).toHaveLength(0);
    } finally {
      db.close();
    }
  });


  it("TRA-LRN-005: contradictory user evidence can supersede prior active learning", () => {
    const db = fixture();
    try {
      const started: any = startProgramSession(db, {
        timezone_at_start: "Europe/Moscow",
        local_date: "2026-10-06",
      });
      const firstFeedback: any = recordTrainingFeedback(db, {
        training_session_id: started.session.training_session_id,
        raw_text: "Я вообще не люблю это упражнение",
      });
      const support: any = recordObservation(db, {
        kind: "EXERCISE_PREFERENCE",
        subject_type: "EXERCISE",
        subject_id: "ex_a",
        statement: "User dislikes exercise",
        persistence_class: "EXPLICITLY_PERSISTENT",
        source_type: "USER_CHAT",
        source_feedback_id: firstFeedback.feedback_id,
        source_session_id: started.session.training_session_id,
      });
      const active: any = upsertLearnedItem(db, {
        kind: "EXERCISE_PREFERENCE",
        subject_type: "EXERCISE",
        subject_id: "ex_a",
        statement: "User dislikes exercise",
        status: "ACTIVE",
        evidence: [{ observation_id: support.observation_id, relation: "SUPPORTS" }],
      });

      const secondFeedback: any = recordTrainingFeedback(db, {
        training_session_id: started.session.training_session_id,
        raw_text: "Сейчас это упражнение мне нормально",
      });
      const contradict: any = recordObservation(db, {
        kind: "EXERCISE_PREFERENCE",
        subject_type: "EXERCISE",
        subject_id: "ex_a",
        statement: "User now considers exercise acceptable",
        persistence_class: "EXPLICITLY_PERSISTENT",
        source_type: "USER_CHAT",
        source_feedback_id: secondFeedback.feedback_id,
        source_session_id: started.session.training_session_id,
      });
      const superseded: any = upsertLearnedItem(db, {
        learned_item_id: active.item.learned_item_id,
        kind: "EXERCISE_PREFERENCE",
        subject_type: "EXERCISE",
        subject_id: "ex_a",
        statement: "Prior dislike is superseded",
        status: "SUPERSEDED",
        evidence: [
          { observation_id: support.observation_id, relation: "SUPPORTS" },
          { observation_id: contradict.observation_id, relation: "CONTRADICTS" },
        ],
      });
      expect(superseded.item.status).toBe("SUPERSEDED");
      expect(superseded.evidence.some((e: any) => e.relation === "CONTRADICTS")).toBe(true);
    } finally {
      db.close();
    }
  });

});
