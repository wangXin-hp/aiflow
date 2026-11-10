import { Module } from "@nestjs/common";
import { WorkflowModule } from "../workflows/workflow.module.js";
import { PrismaRunRepository } from "./prisma-run.repository.js";
import { RunController } from "./run.controller.js";
import { RunEventHub } from "./run-event-hub.js";
import { RunEventStreamService } from "./run-event-stream.service.js";
import { RunEventWriter } from "./run-event-writer.js";
import { runExecutionProviders } from "./run-execution.providers.js";
import { RUN_REPOSITORY } from "./run.repository.js";
import { RunService } from "./run.service.js";

/** RunModule 组合唯一的进程内协调器与数据库真相源，启动时注册遗留运行恢复。 */
@Module({
  imports: [WorkflowModule],
  controllers: [RunController],
  providers: [
    RunEventHub,
    RunEventWriter,
    RunEventStreamService,
    PrismaRunRepository,
    { provide: RUN_REPOSITORY, useExisting: PrismaRunRepository },
    RunService,
    ...runExecutionProviders,
  ],
})
export class RunModule {}
