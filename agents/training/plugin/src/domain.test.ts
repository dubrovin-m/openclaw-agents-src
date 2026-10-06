import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeExercise,
  finishSession,
  getRecommendation,
  prescribeExercise,
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
});
