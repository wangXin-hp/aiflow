BEGIN;

-- 运行必须归属于工作流 owner，且发布版本必须来自同一工作流。
ALTER TABLE "WorkflowRun" DROP CONSTRAINT "WorkflowRun_workflowId_fkey";
ALTER TABLE "WorkflowRun" DROP CONSTRAINT "WorkflowRun_workflowVersionId_fkey";

CREATE UNIQUE INDEX "Workflow_id_ownerId_key" ON "Workflow"("id", "ownerId");
CREATE UNIQUE INDEX "WorkflowVersion_id_workflowId_key" ON "WorkflowVersion"("id", "workflowId");

ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_ownerId_fkey"
FOREIGN KEY ("workflowId", "ownerId") REFERENCES "Workflow"("id", "ownerId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowVersionId_workflowId_fkey"
FOREIGN KEY ("workflowVersionId", "workflowId") REFERENCES "WorkflowVersion"("id", "workflowId")
ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
