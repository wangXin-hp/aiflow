import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import {
  CreateWorkflowRequestSchema,
  UpdateWorkflowRequestSchema,
  WorkflowListQuerySchema,
  type CreateWorkflowRequest,
  type UpdateWorkflowRequest,
  type WorkflowListQuery,
  type PublicUser,
} from "@aiflow/contracts";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { WorkflowService } from "./workflow.service.js";

const workflowIdPipe = new ZodValidationPipe(z.uuid());

/** HTTP 层只负责共享契约、当前用户与状态码；图与归属规则由服务层统一执行。 */
@Controller("workflows")
export class WorkflowController {
  constructor(
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
  ) {}

  @Post()
  async create(
    @CurrentUser() user: PublicUser,
    @Body(new ZodValidationPipe(CreateWorkflowRequestSchema))
    input: CreateWorkflowRequest,
  ) {
    return {
      success: true as const,
      data: await this.workflows.create(user.id, input),
    };
  }

  @Get()
  async list(
    @CurrentUser() user: PublicUser,
    @Query(new ZodValidationPipe(WorkflowListQuerySchema))
    query: WorkflowListQuery,
  ) {
    return {
      success: true as const,
      data: await this.workflows.list(user.id, query),
    };
  }

  @Get(":id")
  async get(
    @CurrentUser() user: PublicUser,
    @Param("id", workflowIdPipe) id: string,
  ) {
    return {
      success: true as const,
      data: await this.workflows.get(user.id, id),
    };
  }

  @Patch(":id")
  async update(
    @CurrentUser() user: PublicUser,
    @Param("id", workflowIdPipe) id: string,
    @Body(new ZodValidationPipe(UpdateWorkflowRequestSchema))
    input: UpdateWorkflowRequest,
  ) {
    return {
      success: true as const,
      data: await this.workflows.update(user.id, id, input),
    };
  }

  /** 归档为幂等的无响应体操作；所属与历史保留由服务和仓储保障。 */
  @Delete(":id")
  @HttpCode(204)
  async archive(
    @CurrentUser() user: PublicUser,
    @Param("id", workflowIdPipe) id: string,
  ): Promise<void> {
    await this.workflows.archive(user.id, id);
  }
}
