import { Type, type Static, type TSchema } from "typebox";
import {
  defineToolPlugin,
  type ToolPluginToolDefinition,
} from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import {
  abandonSession,
  applyApprovedProgramChange,
  completeConditioning,
  completeExercise,
  createConditioningPrescription,
  correctSetResult,
  deferExercise,
  finishSession,
  getConditioningPrescription,
  getProgressionCandidate,
  getRecommendation,
  getRelevantLearning,
  getSession,
  pauseSession,
  prescribeExercise,
  proposeProgramChange,
  recordObservation,
  recordTrainingFeedback,
  recordObservation,
  recordTrainingFeedback,
  resumeExercise,
  resumeSession,
  skipExercise,
  startAdHocSession,
  startProgramSession,
  upsertLearnedItem,
  voidSession,
  type ActualSet,
  type AdHocStrengthExercise,
  type ConditioningSegmentActual,
  type ConditioningSegmentInput,
  type PrescribedSet,
  type ProgramChangeType,
} from "./domain.js";
import { healthSnapshot, openTrainingStore } from "./store.js";

const configSchema = Type.Object({
  databasePath: Type.String({ minLength: 1, pattern: "^/" }),
}, { additionalProperties: false });
type TrainingConfig = Static<typeof configSchema>;

type OwnerToolSpec<T extends TSchema> = {
  name: string;
  label: string;
  description: string;
  parameters: T;
  mutate?: boolean;
  execute: (params: Static<T>, config: TrainingConfig) => unknown;
};

function withDb<T>(config: TrainingConfig, effect: (db: ReturnType<typeof openTrainingStore>) => T): T {
  const db = openTrainingStore(config.databasePath);
  try {
    return effect(db);
  } finally {
    db.close();
  }
}

function ownerTool<T extends TSchema>(
  definition: OwnerToolSpec<T>,
): ToolPluginToolDefinition<TrainingConfig, T> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    optional: true,
    factory: ({ config, toolContext }) => {
      if (toolContext.agentId !== "training" || toolContext.senderIsOwner !== true) {
        return null;
      }
      return {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters,
        async execute(_toolCallId, rawParams) {
          if (definition.mutate) {
            if (!toolContext.assertInvocationCurrent) {
              throw new Error("Training mutation authority is unavailable");
            }
            // No awaited preparation is allowed between this final authority check
            // and the synchronous SQLite mutation path.
            toolContext.assertInvocationCurrent();
          }
          return jsonResult(
            await definition.execute(rawParams as Static<T>, config),
          );
        },
      };
    },
  };
}

const empty = Type.Object({}, { additionalProperties: false });
const sessionId = Type.String({ minLength: 1, maxLength: 100 });
const sessionExerciseId = Type.String({ minLength: 1, maxLength: 100 });

const prescribedSet = Type.Object({
  set_number: Type.Integer({ minimum: 1, maximum: 20 }),
  candidate_reps: Type.Union([Type.Integer({ minimum: 0, maximum: 200 }), Type.Null()]),
  candidate_load_kg: Type.Union([Type.Number({ minimum: 0, maximum: 1000 }), Type.Null()]),
  candidate_rir: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
  target_reps: Type.Union([Type.Integer({ minimum: 0, maximum: 200 }), Type.Null()]),
  target_load_kg: Type.Union([Type.Number({ minimum: 0, maximum: 1000 }), Type.Null()]),
  target_rir: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
  prescription_reason: Type.Optional(Type.Union([
    Type.String({ maxLength: 500 }),
    Type.Null(),
  ])),
}, { additionalProperties: false });

const actualSet = Type.Object({
  set_number: Type.Integer({ minimum: 1, maximum: 20 }),
  reps: Type.Integer({ minimum: 0, maximum: 200 }),
  load_kg: Type.Union([Type.Number({ minimum: 0, maximum: 1000 }), Type.Null()]),
  rir: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
  notes: Type.Optional(Type.Union([
    Type.String({ maxLength: 500 }),
    Type.Null(),
  ])),
}, { additionalProperties: false });

const entry = defineToolPlugin({
  id: "training",
  name: "Training",
  description: "Owner-scoped deterministic Training Store and session execution tools.",
  configSchema,
  tools: (tool) => [
    tool(ownerTool({
      name: "training_status",
      label: "Training status",
      description: "Validate Training Store integrity and return non-sensitive schema/count status.",
      parameters: empty,
      execute: (_params, config) => withDb(config, healthSnapshot),
    })),
    tool(ownerTool({
      name: "training_recommendation_get",
      label: "Training recommendation",
      description: "Read the current program cursor and recommended workout preview without starting a session.",
      parameters: empty,
      execute: (_params, config) => withDb(config, getRecommendation),
    })),
    tool(ownerTool({
      name: "training_session_get",
      label: "Training session",
      description: "Read the current open session or one named session.",
      parameters: Type.Object({
        training_session_id: Type.Optional(sessionId),
      }, { additionalProperties: false }),
      execute: (params, config) =>
        withDb(config, (db) => getSession(db, params.training_session_id)),
    })),
    tool(ownerTool({
      name: "training_session_start",
      label: "Start training session",
      description: "Start the recommended program slot or one explicitly selected program slot. Does not mutate the permanent program.",
      parameters: Type.Object({
        selected_program_slot_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        timezone_at_start: Type.String({ minLength: 1, maxLength: 100 }),
        local_date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => startProgramSession(db, params)),
    })),
    tool(ownerTool({
      name: "training_progression_get",
      label: "Training progression candidate",
      description: "Calculate a deterministic working-load candidate from the approved progression policy and comparable history.",
      parameters: Type.Object({
        session_exercise_id: sessionExerciseId,
      }, { additionalProperties: false }),
      execute: (params, config) =>
        withDb(config, (db) => getProgressionCandidate(db, params.session_exercise_id)),
    })),
    tool(ownerTool({
      name: "training_session_start_ad_hoc",
      label: "Start ad-hoc training session",
      description: "Start an explicitly requested ad-hoc strength or conditioning session without moving the program cursor.",
      parameters: Type.Object({
        session_kind: Type.Union([Type.Literal("STRENGTH"), Type.Literal("CONDITIONING")]),
        timezone_at_start: Type.String({ minLength: 1, maxLength: 100 }),
        local_date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
        strength_exercises: Type.Optional(Type.Array(Type.Object({
          exercise_id: Type.String({ minLength: 1, maxLength: 100 }),
          planned_sets: Type.Integer({ minimum: 1, maximum: 20 }),
          target_reps_min: Type.Union([Type.Integer({ minimum: 0, maximum: 200 }), Type.Null()]),
          target_reps_max: Type.Union([Type.Integer({ minimum: 0, maximum: 200 }), Type.Null()]),
          target_rir_min: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
          target_rir_max: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
          progression_policy_json: Type.Optional(Type.String({ maxLength: 2000 })),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 20 })),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) =>
          startAdHocSession(db, {
            ...params,
            strength_exercises: params.strength_exercises as AdHocStrengthExercise[] | undefined,
          })),
    })),
    tool(ownerTool({
      name: "training_conditioning_get",
      label: "Conditioning prescription",
      description: "Read one persisted Conditioning prescription, segments, and result.",
      parameters: Type.Object({
        conditioning_prescription_id: Type.String({ minLength: 1, maxLength: 100 }),
      }, { additionalProperties: false }),
      execute: (params, config) =>
        withDb(config, (db) => getConditioningPrescription(db, params.conditioning_prescription_id)),
    })),
    tool(ownerTool({
      name: "training_conditioning_prescribe",
      label: "Prescribe Conditioning",
      description: "Persist the complete modality-specific Conditioning protocol before presenting it to the user.",
      parameters: Type.Object({
        training_session_id: sessionId,
        recommended_modality_id: Type.Optional(Type.Union([
          Type.String({ minLength: 1, maxLength: 100 }),
          Type.Null(),
        ])),
        selected_modality_id: Type.String({ minLength: 1, maxLength: 100 }),
        modality_selection_source: Type.Union([
          Type.Literal("AGENT_RECOMMENDATION"),
          Type.Literal("USER_OVERRIDE"),
          Type.Literal("USER_AD_HOC"),
        ]),
        protocol_summary: Type.Optional(Type.Union([
          Type.String({ maxLength: 2000 }),
          Type.Null(),
        ])),
        segments: Type.Array(Type.Object({
          sequence: Type.Integer({ minimum: 1, maximum: 100 }),
          segment_type: Type.Union([
            Type.Literal("WARMUP"),
            Type.Literal("WORK"),
            Type.Literal("RECOVERY"),
            Type.Literal("COOLDOWN"),
          ]),
          target_duration_sec: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 86400 }), Type.Null()])),
          target_distance_m: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 1000000 }), Type.Null()])),
          target_hr_min: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 250 }), Type.Null()])),
          target_hr_max: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 250 }), Type.Null()])),
          target_hr_zone: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 5 }), Type.Null()])),
          target_power_w: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 5000 }), Type.Null()])),
          target_cadence: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 500 }), Type.Null()])),
          notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => createConditioningPrescription(db, {
          ...params,
          segments: params.segments as ConditioningSegmentInput[],
        })),
    })),
    tool(ownerTool({
      name: "training_conditioning_complete",
      label: "Complete Conditioning",
      description: "Record Conditioning completion without requiring Fitbit telemetry.",
      parameters: Type.Object({
        conditioning_prescription_id: Type.String({ minLength: 1, maxLength: 100 }),
        mode: Type.Union([Type.Literal("AS_PRESCRIBED"), Type.Literal("ACTUALS")]),
        actual_duration_sec: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 86400 }), Type.Null()])),
        actual_distance_m: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 1000000 }), Type.Null()])),
        actual_avg_power_w: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 5000 }), Type.Null()])),
        actual_avg_cadence: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 500 }), Type.Null()])),
        rpe: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()])),
        notes: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
        segments: Type.Optional(Type.Array(Type.Object({
          sequence: Type.Integer({ minimum: 1, maximum: 100 }),
          actual_duration_sec: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 86400 }), Type.Null()])),
          actual_distance_m: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 1000000 }), Type.Null()])),
          actual_avg_hr: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 250 }), Type.Null()])),
          actual_max_hr: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 250 }), Type.Null()])),
          actual_power_w: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 5000 }), Type.Null()])),
          actual_cadence: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 500 }), Type.Null()])),
          notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 100 })),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => completeConditioning(db, {
          ...params,
          segments: params.segments as ConditioningSegmentActual[] | undefined,
        })),
    })),
    tool(ownerTool({
      name: "training_exercise_prescribe",
      label: "Prescribe exercise",
      description: "Persist the final working-set prescription before presenting it to the user.",
      parameters: Type.Object({
        session_exercise_id: sessionExerciseId,
        sets: Type.Array(prescribedSet, { minItems: 1, maxItems: 20 }),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) =>
          prescribeExercise(
            db,
            params.session_exercise_id,
            params.sets as PrescribedSet[],
          )),
    })),
    tool(ownerTool({
      name: "training_exercise_complete",
      label: "Complete exercise",
      description: "Record one exercise exactly as prescribed or with explicit per-set actuals.",
      parameters: Type.Object({
        session_exercise_id: sessionExerciseId,
        mode: Type.Union([
          Type.Literal("AS_PRESCRIBED"),
          Type.Literal("ACTUALS"),
        ]),
        sets: Type.Optional(Type.Array(actualSet, { minItems: 1, maxItems: 20 })),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) =>
          completeExercise(
            db,
            params.session_exercise_id,
            params.mode,
            (params.sets ?? []) as ActualSet[],
          )),
    })),
    tool(ownerTool({
      name: "training_exercise_defer",
      label: "Defer exercise",
      description: "Temporarily defer one exercise in the current session.",
      parameters: Type.Object({
        session_exercise_id: sessionExerciseId,
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => deferExercise(db, params.session_exercise_id)),
    })),
    tool(ownerTool({
      name: "training_exercise_resume",
      label: "Resume exercise",
      description: "Return one deferred exercise to ACTIVE state without changing its durable prescription.",
      parameters: Type.Object({
        session_exercise_id: sessionExerciseId,
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => resumeExercise(db, params.session_exercise_id)),
    })),
    tool(ownerTool({
      name: "training_exercise_skip",
      label: "Skip exercise",
      description: "Skip one exercise for the current session without changing the permanent program.",
      parameters: Type.Object({
        session_exercise_id: sessionExerciseId,
        reason: Type.Optional(Type.String({ maxLength: 500 })),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) =>
          skipExercise(db, params.session_exercise_id, params.reason)),
    })),
    tool(ownerTool({
      name: "training_session_pause",
      label: "Pause training session",
      description: "Pause the current session without advancing the program cursor.",
      parameters: Type.Object({ training_session_id: sessionId }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => pauseSession(db, params.training_session_id)),
    })),
    tool(ownerTool({
      name: "training_session_resume",
      label: "Resume training session",
      description: "Resume a durable paused session.",
      parameters: Type.Object({ training_session_id: sessionId }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => resumeSession(db, params.training_session_id)),
    })),
    tool(ownerTool({
      name: "training_session_abandon",
      label: "Abandon training session",
      description: "End a real unfinished session without advancing the program cursor.",
      parameters: Type.Object({
        training_session_id: sessionId,
        reason: Type.Optional(Type.String({ maxLength: 500 })),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => abandonSession(db, params.training_session_id, params.reason)),
    })),
    tool(ownerTool({
      name: "training_session_finish",
      label: "Finish training session",
      description: "Complete the current session, explicitly skip remaining work, and apply the program cursor semantics.",
      parameters: Type.Object({
        training_session_id: sessionId,
        overall_feedback: Type.Optional(Type.Union([
          Type.String({ maxLength: 4000 }),
          Type.Null(),
        ])),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) =>
          finishSession(db, params.training_session_id, params.overall_feedback)),
    })),
    tool(ownerTool({
      name: "training_set_correct",
      label: "Correct set result",
      description: "Correct exactly one field on a completed working set and preserve an audit record.",
      parameters: Type.Object({
        session_set_id: Type.String({ minLength: 1, maxLength: 100 }),
        field: Type.Union([
          Type.Literal("reps"),
          Type.Literal("load_kg"),
          Type.Literal("rir"),
        ]),
        value: Type.Union([Type.Number({ minimum: 0, maximum: 1000 }), Type.Null()]),
        reason: Type.Optional(Type.String({ maxLength: 500 })),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => {
          if (params.field === "reps" && params.value === null) {
            throw new Error("reps correction cannot be null");
          }
          const patch =
            params.field === "reps" ? { reps: Number(params.value) }
            : params.field === "load_kg" ? { load_kg: params.value }
            : { rir: params.value };
          return correctSetResult(db, params.session_set_id, patch, params.reason);
        }),
    })),
    tool(ownerTool({
      name: "training_feedback_record",
      label: "Record training feedback",
      description: "Persist bounded user feedback for one training session or exercise.",
      parameters: Type.Object({
        training_session_id: sessionId,
        session_exercise_id: Type.Optional(Type.Union([sessionExerciseId, Type.Null()])),
        raw_text: Type.String({ minLength: 1, maxLength: 4000 }),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => recordTrainingFeedback(db, params)),
    })),
    tool(ownerTool({
      name: "training_observation_record",
      label: "Record training observation",
      description: "Persist one structured training-domain observation with provenance.",
      parameters: Type.Object({
        kind: Type.String({ minLength: 1, maxLength: 100 }),
        subject_type: Type.String({ minLength: 1, maxLength: 100 }),
        subject_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
        statement: Type.String({ minLength: 1, maxLength: 4000 }),
        structured_value: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        persistence_class: Type.Union([
          Type.Literal("SITUATIONAL"),
          Type.Literal("POTENTIALLY_PERSISTENT"),
          Type.Literal("EXPLICITLY_PERSISTENT"),
        ]),
        source_type: Type.Union([
          Type.Literal("USER_CHAT"),
          Type.Literal("PERFORMANCE"),
          Type.Literal("AGENT_ANALYSIS"),
          Type.Literal("MIGRATION"),
        ]),
        source_feedback_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
        source_session_id: Type.Optional(Type.Union([sessionId, Type.Null()])),
        observed_at: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => recordObservation(db, params as Parameters<typeof recordObservation>[1])),
    })),
    tool(ownerTool({
      name: "training_learning_get",
      label: "Training learning",
      description: "Read active learned training context and optionally current hypotheses for one subject.",
      parameters: Type.Object({
        subject_type: Type.String({ minLength: 1, maxLength: 100 }),
        subject_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
        include_hypotheses: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
      execute: (params, config) =>
        withDb(config, (db) => getRelevantLearning(db, params)),
    })),
    tool(ownerTool({
      name: "training_learning_upsert",
      label: "Update training learning",
      description: "Create or revise a training-domain hypothesis/preference using explicit evidence links. ACTIVE state requires independent external evidence.",
      parameters: Type.Object({
        learned_item_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        kind: Type.String({ minLength: 1, maxLength: 100 }),
        subject_type: Type.String({ minLength: 1, maxLength: 100 }),
        subject_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
        statement: Type.String({ minLength: 1, maxLength: 4000 }),
        value: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        status: Type.Union([
          Type.Literal("HYPOTHESIS"),
          Type.Literal("ACTIVE"),
          Type.Literal("SUPERSEDED"),
          Type.Literal("REJECTED"),
        ]),
        promotion_basis: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
        evidence: Type.Array(Type.Object({
          observation_id: Type.String({ minLength: 1, maxLength: 100 }),
          relation: Type.Union([Type.Literal("SUPPORTS"), Type.Literal("CONTRADICTS")]),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => upsertLearnedItem(db, params as Parameters<typeof upsertLearnedItem>[1])),
    })),
    tool(ownerTool({
      name: "training_feedback_record",
      label: "Record training feedback",
      description: "Persist relevant user feedback for a Training Session or one exercise without copying the full conversation.",
      parameters: Type.Object({
        training_session_id: sessionId,
        session_exercise_id: Type.Optional(Type.Union([
          Type.String({ minLength: 1, maxLength: 100 }),
          Type.Null(),
        ])),
        raw_text: Type.String({ minLength: 1, maxLength: 4000 }),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => recordTrainingFeedback(db, params)),
    })),
    tool(ownerTool({
      name: "training_observation_record",
      label: "Record training observation",
      description: "Persist one bounded training-domain observation with explicit provenance and persistence class.",
      parameters: Type.Object({
        kind: Type.String({ minLength: 1, maxLength: 100 }),
        subject_type: Type.String({ minLength: 1, maxLength: 100 }),
        subject_id: Type.Optional(Type.Union([
          Type.String({ minLength: 1, maxLength: 100 }),
          Type.Null(),
        ])),
        statement: Type.String({ minLength: 1, maxLength: 4000 }),
        structured_value: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        persistence_class: Type.Union([
          Type.Literal("SITUATIONAL"),
          Type.Literal("POTENTIALLY_PERSISTENT"),
          Type.Literal("EXPLICITLY_PERSISTENT"),
        ]),
        source_type: Type.Union([
          Type.Literal("USER_CHAT"),
          Type.Literal("PERFORMANCE"),
          Type.Literal("AGENT_ANALYSIS"),
        ]),
        source_feedback_id: Type.Optional(Type.Union([
          Type.String({ minLength: 1, maxLength: 100 }),
          Type.Null(),
        ])),
        source_session_id: Type.Optional(Type.Union([
          Type.String({ minLength: 1, maxLength: 100 }),
          Type.Null(),
        ])),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => recordObservation(db, params)),
    })),
    tool(ownerTool({
      name: "training_learning_upsert",
      label: "Update training learning",
      description: "Create or update one evidence-backed training preference or hypothesis. ACTIVE requires explicitly persistent user evidence.",
      parameters: Type.Object({
        learned_item_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        kind: Type.String({ minLength: 1, maxLength: 100 }),
        subject_type: Type.String({ minLength: 1, maxLength: 100 }),
        subject_id: Type.Optional(Type.Union([
          Type.String({ minLength: 1, maxLength: 100 }),
          Type.Null(),
        ])),
        statement: Type.String({ minLength: 1, maxLength: 4000 }),
        value: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        status: Type.Union([
          Type.Literal("HYPOTHESIS"),
          Type.Literal("ACTIVE"),
          Type.Literal("SUPERSEDED"),
          Type.Literal("REJECTED"),
        ]),
        promotion_basis: Type.Optional(Type.Union([
          Type.String({ maxLength: 1000 }),
          Type.Null(),
        ])),
        evidence: Type.Array(Type.Object({
          observation_id: Type.String({ minLength: 1, maxLength: 100 }),
          relation: Type.Union([
            Type.Literal("SUPPORTS"),
            Type.Literal("CONTRADICTS"),
          ]),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 50 }),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => upsertLearnedItem(db, params)),
    })),
    tool(ownerTool({
      name: "training_learning_get",
      label: "Get relevant training learning",
      description: "Read active training-domain learning for one subject, optionally including hypotheses.",
      parameters: Type.Object({
        subject_type: Type.String({ minLength: 1, maxLength: 100 }),
        subject_id: Type.Optional(Type.Union([
          Type.String({ minLength: 1, maxLength: 100 }),
          Type.Null(),
        ])),
        include_hypotheses: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
      execute: (params, config) =>
        withDb(config, (db) => getRelevantLearning(db, params)),
    })),
    tool(ownerTool({
      name: "training_program_change_propose",
      label: "Propose training program change",
      description: "Create an auditable bounded permanent-program change proposal without changing the active Program Version.",
      parameters: Type.Object({
        change: Type.Union([
          Type.Object({
            change_type: Type.Literal("REPLACE_EXERCISE"),
            proposal: Type.Object({
              template_exercise_id: Type.String({ minLength: 1, maxLength: 100 }),
              replacement_exercise_id: Type.String({ minLength: 1, maxLength: 100 }),
            }, { additionalProperties: false }),
          }, { additionalProperties: false }),
          Type.Object({
            change_type: Type.Literal("UPDATE_EXERCISE_TARGETS"),
            proposal: Type.Object({
              template_exercise_id: Type.String({ minLength: 1, maxLength: 100 }),
              target_sets: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
              target_reps_min: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 200 }), Type.Null()])),
              target_reps_max: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 200 }), Type.Null()])),
              target_rir_min: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()])),
              target_rir_max: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()])),
              progression_policy_json: Type.Optional(Type.String({ minLength: 2, maxLength: 2000 })),
            }, { additionalProperties: false }),
          }, { additionalProperties: false }),
          Type.Object({
            change_type: Type.Literal("UPDATE_CONDITIONING_POLICY"),
            proposal: Type.Object({
              conditioning_policy_id: Type.String({ minLength: 1, maxLength: 100 }),
              objective: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
              min_duration_sec: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 86400 }), Type.Null()])),
              max_duration_sec: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 86400 }), Type.Null()])),
              intensity_basis: Type.Optional(Type.Union([
                Type.Literal("HR_ZONE"),Type.Literal("HEART_RATE"),Type.Literal("RPE"),
                Type.Literal("POWER"),Type.Literal("PACE"),Type.Literal("MIXED"),Type.Null()
              ])),
              modality_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 })),
            }, { additionalProperties: false }),
          }, { additionalProperties: false }),
        ]),
        rationale: Type.String({ minLength: 1, maxLength: 4000 }),
        created_by: Type.Optional(Type.Union([Type.Literal("TRAINING_AGENT"), Type.Literal("USER")])),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => proposeProgramChange(db, {
          change_type: params.change.change_type as ProgramChangeType,
          proposal: params.change.proposal as Record<string, unknown>,
          rationale: params.rationale,
          created_by: params.created_by,
        })),
    })),
    tool(ownerTool({
      name: "training_program_change_apply",
      label: "Apply approved training program change",
      description: "Apply exactly one pending user-approved proposal by creating a new immutable Program Version starting from Strength A.",
      parameters: Type.Object({
        proposal_id: Type.String({ minLength: 1, maxLength: 100 }),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) => applyApprovedProgramChange(db, params.proposal_id, "USER")),
    })),
    tool(ownerTool({
      name: "training_session_void",
      label: "Void training session",
      description: "Void an erroneously created or test session so it is excluded from training analytics.",
      parameters: Type.Object({
        training_session_id: sessionId,
        reason: Type.Optional(Type.String({ maxLength: 500 })),
      }, { additionalProperties: false }),
      mutate: true,
      execute: (params, config) =>
        withDb(config, (db) =>
          voidSession(db, params.training_session_id, params.reason)),
    })),
  ],
});

export default entry;
