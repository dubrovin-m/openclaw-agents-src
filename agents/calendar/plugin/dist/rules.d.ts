export type DurableClassificationRule = {
    id: string;
    condition: string;
    categoryId: string;
};
export type DurableHygieneException = {
    id: string;
    condition: string;
    requireLeader: boolean;
    requireAgenda: boolean;
};
export type DurableRules = {
    classification: DurableClassificationRule[];
    hygiene: DurableHygieneException[];
};
export type RuleProposalInput = {
    action: "create" | "replace" | "delete";
    kind: "classification" | "hygiene_exception";
    rule_id?: string;
    condition?: string;
    category_id?: string;
    require_leader?: boolean;
    require_agenda?: boolean;
};
type RuleConfigView = {
    leaves: Array<{
        id: string;
    }>;
    durableRules: DurableRules;
};
export type StoredRuleProposal = {
    proposalId: string;
    action: RuleProposalInput["action"];
    kind: RuleProposalInput["kind"];
    targetDigest?: string;
    rule?: DurableClassificationRule | DurableHygieneException;
    ruleId?: string;
    summary: string;
    createdAt: number;
};
export declare const RULE_PROPOSAL_TTL_MS: number;
export declare const MAX_RULE_PROPOSALS = 100;
export type RuleProposalStore = {
    register(key: string, value: StoredRuleProposal, opts?: {
        ttlMs?: number;
    }): Promise<void>;
    lookup(key: string): Promise<StoredRuleProposal | undefined>;
    delete(key: string): Promise<boolean>;
};
export declare function parseDurableRules(value: unknown): DurableRules;
export declare function rulesDigest(rules: DurableRules): string;
export declare function proposeRule(config: RuleConfigView, input: RuleProposalInput, store: RuleProposalStore): Promise<{
    rule_id?: string | undefined;
    rule?: DurableClassificationRule | DurableHygieneException | undefined;
    proposal_id: string;
    action: "create" | "replace" | "delete";
    kind: "classification" | "hygiene_exception";
    summary: string;
}>;
export declare function getRuleProposal(proposalId: string, store: RuleProposalStore): Promise<StoredRuleProposal | undefined>;
export declare function deleteRuleProposal(proposalId: string, store: RuleProposalStore): Promise<boolean>;
export declare function applyRuleProposal(rules: DurableRules, proposal: StoredRuleProposal): DurableRules;
export {};
