import { describe, expect, it, vi } from "vitest";
import {
  buildManagementReviewScript,
  executeManagementReview,
  managementReviewInternals,
  TASK_MANAGEMENT_REVIEW_TOOL,
} from "./management-review.js";

const BOUNDARY = "2026-09-22T16:00:00.000Z";

function snapshot(overrides:Record<string,unknown>={}) {
  return {
    ok:true,
    boundary:BOUNDARY,
    local_date:"2026-09-22",
    completed:[{id:"T-1",title:"Закрыть вопрос",assignee:"Иванов И.",completed_at:"2026-09-22T10:00:00.000Z"}],
    not_completed:[
      {id:"T-2",title:"Получить согласование",assignee:"Петров П.",due_date:"2026-09-20",due_time:null,pending_deadline_change_request:{status:"PENDING",requested_due_date:"2026-09-27",requested_due_time:null,reason:"Ждет юристов"},comments:[]},
      {id:"T-3",title:"Подготовить расчет",assignee:"Петров П.",due_date:"2026-09-22",due_time:"18:00",pending_deadline_change_request:null,comments:[{id:"C-1",content:"Не получены данные от подрядчика",created_at:"2026-09-22T12:00:00.000Z"}]},
      {id:"T-4",title:"Направить справку",assignee:"Сидоров С.",due_date:"2026-09-21",due_time:null,pending_deadline_change_request:null,comments:[]},
    ],
    ...overrides,
  };
}

describe("Task Management Review scheduler-only tool", () => {
  it("builds a script that fixes a boundary before the snapshot call", () => {
    const script=buildManagementReviewScript();
    expect(script).toContain(`await ${TASK_MANAGEMENT_REVIEW_TOOL}({ boundary: new Date().toISOString() })`);
    expect(script).toContain("notify: review.message");
  });

  it("is context-gated to tasks cron session keys", () => {
    expect(managementReviewInternals.parseCurrentCronJobId({agentId:"tasks",sessionKey:"agent:tasks:cron:job-1:trigger"} as never)).toBe("job-1");
    expect(managementReviewInternals.parseCurrentCronJobId({agentId:"tasks",sessionKey:"agent:tasks:main"} as never)).toBeNull();
  });

  it("fails closed on a boundary mismatch", async () => {
    await expect(executeManagementReview({boundary:BOUNDARY},{runSnapshot:async()=>snapshot({boundary:"2026-09-22T15:00:00.000Z"}) as never})).rejects.toThrow("boundary mismatch");
  });

  it("renders completed and non-completed sections with formal requests, explanatory comments, and missing-reason flags", async () => {
    const model=vi.fn(async()=>JSON.stringify({explanations:[{task_id:"T-3",comment_id:"C-1"}]}));
    const result=await executeManagementReview({boundary:BOUNDARY},{runSnapshot:async()=>snapshot() as never,runSemanticModel:model});
    expect(result.completed_count).toBe(1);
    expect(result.not_completed_count).toBe(3);
    expect(result.semantic_calls).toBe(1);
    expect(result.message).toContain("✅ ВЫПОЛНЕНО 1");
    expect(result.message).toContain("🔴 НЕ ВЫПОЛНЕНО 3");
    expect(result.message).toContain("Запрос: перенос до 27 сен");
    expect(result.message).toContain("Причина: Ждет юристов");
    expect(result.message).toContain("Комментарий: Не получены данные от подрядчика");
    expect(result.message).toContain("⚠️ Причина не указана");
  });

  it("rejects semantic selections outside the bounded comments", () => {
    const parsed=managementReviewInternals.parseSnapshot(snapshot(),BOUNDARY);
    const task=parsed.notCompleted.filter((x:any)=>x.id==="T-3");
    expect(()=>managementReviewInternals.parseSelections('{"explanations":[{"task_id":"T-3","comment_id":"C-999"}]}',task)).toThrow("bounded IDs");
  });
});
