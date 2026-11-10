import { Module } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller.js";
import { PrismaWorkflowRepository } from "./prisma-workflow.repository.js";
import { WORKFLOW_REPOSITORY } from "./workflow.repository.js";
import { WorkflowService } from "./workflow.service.js";

/** 只在模块组合根绑定 Prisma 适配器，控制器和领域服务保持仓储端口依赖。 */
@Module({
  controllers: [WorkflowController],
  providers: [
    WorkflowService,
    PrismaWorkflowRepository,
    { provide: WORKFLOW_REPOSITORY, useExisting: PrismaWorkflowRepository },
  ],
})
export class WorkflowModule {}
