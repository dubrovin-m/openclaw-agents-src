import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  healthSnapshot,
  openTrainingStore,
  TRAINING_SCHEMA_VERSION,
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
});
