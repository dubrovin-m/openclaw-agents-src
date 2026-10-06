#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [databasePath, inputPath] = process.argv.slice(2);
if (!databasePath || !inputPath || !path.isAbsolute(databasePath) || !path.isAbsolute(inputPath)) {
  console.error("Usage: node import.mjs /absolute/path/training.sqlite3 /absolute/path/normalized-training.json");
  process.exit(2);
}

const raw = fs.readFileSync(inputPath);
const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
let payload;
try {
  payload = JSON.parse(raw.toString("utf8"));
} catch (error) {
  console.error(`Invalid migration JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const { openTrainingStore, healthSnapshot } = await import("../plugin/dist/store.js");
const { importNormalizedTraining } = await import("../plugin/dist/migration.js");

const db = openTrainingStore(databasePath);
try {
  const migration = importNormalizedTraining(db, payload, sha256);
  const health = healthSnapshot(db);
  process.stdout.write(JSON.stringify({ migration, health }, null, 2) + "\n");
} finally {
  db.close();
}
