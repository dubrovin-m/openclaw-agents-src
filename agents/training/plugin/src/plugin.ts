import { Type, type Static, type TSchema } from "typebox";
import {
  defineToolPlugin,
  type ToolPluginToolDefinition,
} from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import {
  abandonSession,
  completeExercise,
  correctSetResult,
  deferExercise,
  finishSession,
  getRecommendation,
  getSession,
  pauseSession,
  prescribeExercise,
  resumeExercise,
  resumeSession,
  skipExercise,
  startProgramSession,
  voidSession,
  type ActualSet,
  type PrescribedSet,
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
          const patch =
            params.field === "reps" ? { reps: Number(params.value) }
            : params.field === "load_kg" ? { load_kg: params.value }
            : { rir: params.value };
          return correctSetResult(db, params.session_set_id, patch, params.reason);
        }),
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
