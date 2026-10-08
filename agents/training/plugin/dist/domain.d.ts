import type { DatabaseSync, SQLInputValue } from "node:sqlite";
type Row = Record<string, SQLInputValue>;
export declare function getOpenSession(db: DatabaseSync): Row | undefined;
export declare function getRecommendation(db: DatabaseSync): {
    active_program: null;
    recommendation: null;
} | {
    active_program: {
        cycle_number: number;
        program_version_id: string;
        program_id: string;
        version_number: number;
    };
    recommendation: {
        exercises: Row[];
        conditioning: {
            modalities: Row[];
        } | null;
        program_slot_id: string;
        sequence: number;
        workout_template_id: string;
        name: string;
        workout_kind: string;
    };
};
export declare function getProgramState(db: DatabaseSync): {
    active_program: null;
    cursor: null;
    slots: never[];
} | {
    active_program: {
        program_version_id: string;
        program_id: string;
        version_number: number;
    };
    cursor: {
        next_program_slot_id: string;
        cycle_number: number;
    };
    slots: {
        exercises: Row[];
        conditioning: {
            modalities: Row[];
        } | null;
        program_slot_id: string;
        sequence: number;
        workout_template_id: string;
        name: string;
        workout_kind: string;
    }[];
};
export declare function searchExercises(db: DatabaseSync, query: string, limit?: number): Row[];
export declare function restartProgramCycle(db: DatabaseSync): {
    replayed: boolean;
    recommendation: {
        active_program: null;
        recommendation: null;
    } | {
        active_program: {
            cycle_number: number;
            program_version_id: string;
            program_id: string;
            version_number: number;
        };
        recommendation: {
            exercises: Row[];
            conditioning: {
                modalities: Row[];
            } | null;
            program_slot_id: string;
            sequence: number;
            workout_template_id: string;
            name: string;
            workout_kind: string;
        };
    };
};
export declare function startProgramSession(db: DatabaseSync, params: {
    selected_program_slot_id?: string;
    selected_workout_template_id?: string;
    selected_workout_kind?: "CONDITIONING";
    timezone_at_start: string;
    local_date: string;
}): {
    replayed: boolean;
    session: {
        exercises: {
            sets: Row[];
        }[];
    } | null;
};
export type AdHocStrengthExercise = {
    exercise_id: string;
    planned_sets: number;
    target_reps_min: number | null;
    target_reps_max: number | null;
    target_rir_min: number | null;
    target_rir_max: number | null;
    target_duration_sec?: number | null;
    target_distance_m?: number | null;
    progression_policy_json?: string;
};
export declare function startAdHocSession(db: DatabaseSync, params: {
    session_kind: "STRENGTH" | "CONDITIONING";
    timezone_at_start: string;
    local_date: string;
    strength_exercises?: AdHocStrengthExercise[];
}): {
    replayed: boolean;
    session: {
        exercises: {
            sets: Row[];
        }[];
    } | null;
};
export declare function getSession(db: DatabaseSync, sessionId?: string): {
    exercises: {
        sets: Row[];
    }[];
} | null;
export type ConditioningSegmentInput = {
    sequence: number;
    segment_type: "WARMUP" | "WORK" | "RECOVERY" | "COOLDOWN";
    target_duration_sec?: number | null;
    target_distance_m?: number | null;
    target_hr_min?: number | null;
    target_hr_max?: number | null;
    target_hr_zone?: number | null;
    target_power_w?: number | null;
    target_cadence?: number | null;
    notes?: string | null;
};
export declare function createConditioningPrescription(db: DatabaseSync, params: {
    training_session_id: string;
    recommended_modality_id?: string | null;
    selected_modality_id: string;
    modality_selection_source: "AGENT_RECOMMENDATION" | "USER_OVERRIDE" | "USER_AD_HOC";
    protocol_summary?: string | null;
    segments: ConditioningSegmentInput[];
}): {
    replayed: boolean;
    prescription: {
        segments: Row[];
        result: Row | null;
    } | null;
};
export declare function getConditioningPrescription(db: DatabaseSync, prescriptionId: string): {
    segments: Row[];
    result: Row | null;
} | null;
export type ConditioningSegmentActual = {
    sequence: number;
    actual_duration_sec?: number | null;
    actual_distance_m?: number | null;
    actual_avg_hr?: number | null;
    actual_max_hr?: number | null;
    actual_power_w?: number | null;
    actual_cadence?: number | null;
    notes?: string | null;
};
export declare function completeConditioning(db: DatabaseSync, params: {
    conditioning_prescription_id: string;
    mode: "AS_PRESCRIBED" | "ACTUALS";
    actual_duration_sec?: number | null;
    actual_distance_m?: number | null;
    actual_avg_power_w?: number | null;
    actual_avg_cadence?: number | null;
    rpe?: number | null;
    notes?: string | null;
    segments?: ConditioningSegmentActual[];
}): {
    replayed: boolean;
    prescription: {
        segments: Row[];
        result: Row | null;
    } | null;
};
export declare function getProgressionCandidate(db: DatabaseSync, sessionExerciseId: string): {
    session_exercise_id: string;
    exercise_id: string;
    target_sets: number;
    target_reps_min: SQLInputValue;
    target_reps_max: SQLInputValue;
    target_rir_min: SQLInputValue;
    target_rir_max: SQLInputValue;
    target_duration_sec: SQLInputValue;
    target_distance_m: SQLInputValue;
    candidate_load_kg: number | null;
    basis: string;
    policy: {
        kind: "DOUBLE_SUCCESS_THEN_INCREMENT" | "HOLD_LAST_LOAD";
        increment_kg: number | null;
        successful_exposures_required: number;
        initial_load_kg: number | null;
    };
    recent_exposures: {
        session_exercise_id: string;
        local_date: string;
        started_at: SQLInputValue;
        load_kg: number | null | undefined;
        success: boolean;
        set_count: number;
    }[];
};
export type PrescribedSet = {
    set_number: number;
    candidate_reps: number | null;
    candidate_load_kg: number | null;
    candidate_rir: number | null;
    candidate_duration_sec?: number | null;
    candidate_distance_m?: number | null;
    target_reps: number | null;
    target_load_kg: number | null;
    target_rir: number | null;
    target_duration_sec?: number | null;
    target_distance_m?: number | null;
    prescription_reason?: string | null;
};
export declare function prescribeExercise(db: DatabaseSync, sessionExerciseId: string, sets: PrescribedSet[]): {
    replayed: boolean;
    exercise: {
        sets: Row[];
    } | null;
};
export declare function getSessionExercise(db: DatabaseSync, id: string): {
    sets: Row[];
} | null;
export type ActualSet = {
    set_number: number;
    reps: number | null;
    load_kg: number | null;
    rir: number | null;
    duration_sec?: number | null;
    distance_m?: number | null;
    notes?: string | null;
};
export declare function completeExercise(db: DatabaseSync, sessionExerciseId: string, mode: "AS_PRESCRIBED" | "ACTUALS", actuals?: ActualSet[]): {
    replayed: boolean;
    exercise: {
        sets: Row[];
    } | null;
};
export declare function deferExercise(db: DatabaseSync, sessionExerciseId: string): {
    replayed: boolean;
    exercise: {
        sets: Row[];
    } | null;
};
export declare function resumeExercise(db: DatabaseSync, sessionExerciseId: string): {
    replayed: boolean;
    exercise: {
        sets: Row[];
    } | null;
};
export declare function pauseSession(db: DatabaseSync, sessionId: string): {
    replayed: boolean;
    session: {
        exercises: {
            sets: Row[];
        }[];
    } | null;
};
export declare function resumeSession(db: DatabaseSync, sessionId: string): {
    replayed: boolean;
    session: {
        exercises: {
            sets: Row[];
        }[];
    } | null;
};
export declare function abandonSession(db: DatabaseSync, sessionId: string, reason?: string): {
    replayed: boolean;
    session: {
        exercises: {
            sets: Row[];
        }[];
    } | null;
};
export declare function substituteExercise(db: DatabaseSync, sessionExerciseId: string, replacementExerciseId: string, reason?: string, equipmentInstanceId?: string | null): {
    replayed: boolean;
    exercise: {
        sets: Row[];
    } | null;
};
export declare function skipExercise(db: DatabaseSync, sessionExerciseId: string, reason?: string): {
    replayed: boolean;
    exercise: {
        sets: Row[];
    } | null;
};
export declare function finishSession(db: DatabaseSync, sessionId: string, overallFeedback?: string | null): {
    replayed: boolean;
    session: {
        exercises: {
            sets: Row[];
        }[];
    } | null;
    next_recommendation: {
        active_program: null;
        recommendation: null;
    } | {
        active_program: {
            cycle_number: number;
            program_version_id: string;
            program_id: string;
            version_number: number;
        };
        recommendation: {
            exercises: Row[];
            conditioning: {
                modalities: Row[];
            } | null;
            program_slot_id: string;
            sequence: number;
            workout_template_id: string;
            name: string;
            workout_kind: string;
        };
    };
};
export declare function voidSession(db: DatabaseSync, sessionId: string, reason?: string): {
    replayed: boolean;
    session: {
        exercises: {
            sets: Row[];
        }[];
    } | null;
};
export declare function correctSetResult(db: DatabaseSync, sessionSetId: string, patch: {
    reps?: number | null;
    load_kg?: number | null;
    rir?: number | null;
    duration_sec?: number | null;
    distance_m?: number | null;
}, reason?: string): {
    replayed: boolean;
    set: Row | undefined;
};
export type ProgramChangeType = "REPLACE_EXERCISE" | "UPDATE_EXERCISE_TARGETS" | "UPDATE_CONDITIONING_POLICY";
export declare function proposeProgramChange(db: DatabaseSync, params: {
    change_type: ProgramChangeType;
    proposal: Record<string, unknown>;
    rationale: string;
    created_by?: "TRAINING_AGENT" | "USER";
}): Row | undefined;
export declare function applyApprovedProgramChange(db: DatabaseSync, proposalId: string, decisionActor?: "USER" | "HEALTH_MAIN"): {
    replayed: boolean;
    proposal: Row;
    active_program: Row | undefined;
    recommendation?: undefined;
} | {
    replayed: boolean;
    proposal: Row | undefined;
    active_program: Row | undefined;
    recommendation: {
        active_program: null;
        recommendation: null;
    } | {
        active_program: {
            cycle_number: number;
            program_version_id: string;
            program_id: string;
            version_number: number;
        };
        recommendation: {
            exercises: Row[];
            conditioning: {
                modalities: Row[];
            } | null;
            program_slot_id: string;
            sequence: number;
            workout_template_id: string;
            name: string;
            workout_kind: string;
        };
    };
};
export declare function recordTrainingFeedback(db: DatabaseSync, params: {
    training_session_id: string;
    session_exercise_id?: string | null;
    raw_text: string;
}): Row | undefined;
export declare function recordObservation(db: DatabaseSync, params: {
    kind: string;
    subject_type: string;
    subject_id?: string | null;
    statement: string;
    structured_value?: Record<string, unknown>;
    persistence_class: "SITUATIONAL" | "POTENTIALLY_PERSISTENT" | "EXPLICITLY_PERSISTENT";
    source_type: "USER_CHAT" | "PERFORMANCE" | "AGENT_ANALYSIS" | "MIGRATION";
    source_feedback_id?: string | null;
    source_session_id?: string | null;
    observed_at?: string;
}): Row | undefined;
export declare function upsertLearnedItem(db: DatabaseSync, params: {
    learned_item_id?: string;
    kind: string;
    subject_type: string;
    subject_id?: string | null;
    statement: string;
    value?: Record<string, unknown>;
    status: "HYPOTHESIS" | "ACTIVE" | "SUPERSEDED" | "REJECTED";
    promotion_basis?: string | null;
    evidence: Array<{
        observation_id: string;
        relation: "SUPPORTS" | "CONTRADICTS";
    }>;
}): {
    item: Row | undefined;
    evidence: Row[];
};
export declare function getRelevantLearning(db: DatabaseSync, params: {
    subject_type: string;
    subject_id?: string | null;
    include_hypotheses?: boolean;
}): Row[];
export {};
