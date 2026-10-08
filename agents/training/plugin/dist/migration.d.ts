import type { DatabaseSync } from "node:sqlite";
type StrengthTemplateExercise = {
    source_id: string;
    exercise_source_id: string;
    sequence: number;
    target_sets: number;
    target_reps_min?: number | null;
    target_reps_max?: number | null;
    target_rir_min?: number | null;
    target_rir_max?: number | null;
    target_duration_sec?: number | null;
    target_distance_m?: number | null;
    progression_policy_json?: string;
    notes?: string | null;
};
type MigrationTemplate = {
    source_id: string;
    name: string;
    workout_kind: "STRENGTH" | "CONDITIONING";
    notes?: string | null;
    strength_exercises?: StrengthTemplateExercise[];
    conditioning_policy?: {
        source_id: string;
        objective: string;
        min_duration_sec?: number | null;
        max_duration_sec?: number | null;
        intensity_basis?: "HR_ZONE" | "HEART_RATE" | "RPE" | "POWER" | "PACE" | "MIXED" | null;
        notes?: string | null;
        modalities: Array<{
            source_id: string;
            name: string;
        }>;
    };
};
export type NormalizedTrainingMigrationV1 = {
    format: "training-normalized-migration-v1";
    source_system: string;
    source_export_id: string;
    exported_at?: string;
    exercises: Array<{
        source_id: string;
        name: string;
        category?: string | null;
        equipment_type?: string | null;
        load_mode: "TOTAL_EXTERNAL" | "PER_HAND" | "PER_SIDE" | "ADDED_BODYWEIGHT" | "ASSISTANCE" | "MACHINE_DISPLAYED" | "BODYWEIGHT" | "NONE";
        rep_mode: "TOTAL" | "PER_SIDE";
        load_progression_direction: "HIGHER_IS_HARDER" | "LOWER_IS_HARDER" | "NOT_APPLICABLE";
    }>;
    program_versions: Array<{
        source_id: string;
        program_source_id: string;
        program_name: string;
        objective?: string | null;
        version_number: number;
        status: "ACTIVE" | "RETIRED";
        progression_policy_json?: string;
        decision_reason?: string | null;
        activated_at?: string | null;
        retired_at?: string | null;
        templates: MigrationTemplate[];
        slots: Array<{
            source_id: string;
            sequence: number;
            template_source_id: string;
        }>;
    }>;
    active_cursor?: {
        program_version_source_id: string;
        next_slot_source_id: string;
        cycle_number: number;
    } | null;
    sessions: Array<{
        source_id: string;
        program_version_source_id?: string | null;
        workout_template_source_id?: string | null;
        selected_slot_source_id?: string | null;
        session_kind: "STRENGTH" | "CONDITIONING";
        status: "COMPLETED" | "ABANDONED" | "VOIDED";
        local_date: string;
        started_at?: string | null;
        ended_at?: string | null;
        timezone_at_start?: string | null;
        overall_feedback?: string | null;
        strength_exercises?: Array<{
            source_id: string;
            exercise_source_id: string;
            sequence: number;
            status: "COMPLETED" | "SKIPPED";
            actual_sets: Array<{
                source_id: string;
                set_number: number;
                status: "COMPLETED" | "SKIPPED";
                actual_reps?: number | null;
                actual_load_kg?: number | null;
                actual_rir?: number | null;
                actual_duration_sec?: number | null;
                actual_distance_m?: number | null;
                notes?: string | null;
            }>;
            notes?: string | null;
        }>;
        conditioning?: {
            source_id: string;
            selected_modality: {
                source_id: string;
                name: string;
            };
            method?: string | null;
            actual_duration_sec?: number | null;
            actual_distance_m?: number | null;
            actual_avg_hr?: number | null;
            actual_avg_power_w?: number | null;
            actual_avg_cadence?: number | null;
            rpe?: number | null;
            notes?: string | null;
        };
    }>;
};
export declare function importNormalizedTraining(db: DatabaseSync, payload: NormalizedTrainingMigrationV1, inputSha256: string): {
    replayed: boolean;
} | {
    migration_batch_id: string;
    source_system: string;
    source_export_id: string;
    counts: {
        exercises: number;
        programs: number;
        program_versions: number;
        workout_templates: number;
        program_slots: number;
        training_sessions: number;
        session_exercises: number;
        session_sets: number;
        conditioning_results: number;
        external_telemetry_links: number;
    };
    replayed: boolean;
};
export {};
