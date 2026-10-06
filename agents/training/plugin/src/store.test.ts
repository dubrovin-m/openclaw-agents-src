import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  healthSnapshot,
  openTrainingStore,
  TRAINING_SCHEMA_VERSION,
  withToolCallReceipt,
  withTransaction,
} from "./store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Training Store", () => {
  it("creates schema v1 with SQLite integrity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "training-store-"));
    roots.push(root);
    const db = openTrainingStore(path.join(root, "training.sqlite3"));
    try {
      const health = healthSnapshot(db);
      expect(health.schema_version).toBe(TRAINING_SCHEMA_VERSION);
      expect(health.integrity).toBe("ok");
      expect(health.foreign_key_violations).toBe(0);
    } finally {
      db.close();
    }
  });

  it("fails closed on a future schema", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "training-store-"));
    roots.push(root);
    const dbPath = path.join(root, "training.sqlite3");
    const db = openTrainingStore(dbPath);
    db.exec("PRAGMA user_version=99");
    db.close();
    expect(() => openTrainingStore(dbPath)).toThrow(/Unsupported Training schema/);
  });

  it("TRA-LIFE-006/007: tool-call receipts replay one operation, separate operation identities, and fail on input mismatch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "training-receipt-"));
    roots.push(root);
    const db = openTrainingStore(path.join(root, "training.sqlite3"));
    try {
      let executions = 0;
      const first = withToolCallReceipt(db, {
        toolCallId: "tool-call-1",
        operationName: "training_test_mutation",
        inputHash: "a".repeat(64),
      }, () => {
        executions += 1;
        withTransaction(db, () => {
          db.prepare("INSERT INTO programs VALUES('receipt-prog','Receipt',NULL,'2026-10-06T00:00:00Z')").run();
        });
        return { ok: true, id: "receipt-prog" };
      });
      expect(first.replayed).toBe(false);

      const replay = withToolCallReceipt(db, {
        toolCallId: "tool-call-1",
        operationName: "training_test_mutation",
        inputHash: "a".repeat(64),
      }, () => {
        executions += 1;
        return { ok: false };
      });
      expect(replay.replayed).toBe(true);
      expect(replay.result).toEqual({ ok: true, id: "receipt-prog" });
      expect(executions).toBe(1);

      const distinctOperation = withToolCallReceipt(db, {
        toolCallId: "tool-call-1",
        operationName: "training_other_mutation",
        inputHash: "b".repeat(64),
      }, () => {
        executions += 1;
        return { ok: true, other: true };
      });
      expect(distinctOperation.replayed).toBe(false);
      expect(executions).toBe(2);

      expect(() => withToolCallReceipt(db, {
        toolCallId: "tool-call-1",
        operationName: "training_test_mutation",
        inputHash: "c".repeat(64),
      }, () => ({ ok: true }))).toThrow(/reused with different input/);
    } finally {
      db.close();
    }
  });

  it("tool-call receipt and nested domain mutation roll back atomically on failure", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "training-receipt-"));
    roots.push(root);
    const db = openTrainingStore(path.join(root, "training.sqlite3"));
    try {
      expect(() => withToolCallReceipt(db, {
        toolCallId: "tool-call-fail",
        operationName: "training_test_failure",
        inputHash: "d".repeat(64),
      }, () => {
        withTransaction(db, () => {
          db.prepare("INSERT INTO programs VALUES('rolled-back','Rollback',NULL,'2026-10-06T00:00:00Z')").run();
        });
        throw new Error("synthetic failure");
      })).toThrow(/synthetic failure/);
      expect(Number((db.prepare("SELECT count(*) n FROM programs WHERE program_id='rolled-back'").get() as any).n)).toBe(0);
      expect(Number((db.prepare("SELECT count(*) n FROM tool_call_receipts WHERE tool_call_id='tool-call-fail'").get() as any).n)).toBe(0);
    } finally {
      db.close();
    }
  });

});
