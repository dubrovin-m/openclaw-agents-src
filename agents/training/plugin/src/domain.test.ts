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
  getRecommendation,
  pauseSession,
  prescribeExercise,
  proposeProgramChange,
  resumeExercise,
  resumeSession,
  startAdHocSession,
  startProgramSession,
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

  db.prepare("INSERT INTO template_exercises VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run("te_a", "tpl_a", "ex_a", 1, 4, 6, 6, 2, 2, "{}", null);
  db.prepare("INSERT INTO template_exercises VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run("te_b", "tpl_b", "ex_b", 1, 4, 6, 6, 2, 2, "{}", null);

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

});
