import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  Sse,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import {
  CreateRunRequestSchema,
  type CreateRunRequest,
  type PublicUser,
} from "@aiflow/contracts";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { ApiError } from "../common/api-error.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RunCoordinator } from "./run-coordinator.js";
import { RunEventStreamService } from "./run-event-stream.service.js";
import { RunService } from "./run.service.js";

const idPipe = new ZodValidationPipe(z.uuid());

/** HTTP 只处理当前身份、共享契约和响应状态；运行状态与归属由服务层决定。 */
@Controller()
export class RunController {
  constructor(
    @Inject(RunService) private readonly runs: RunService,
    @Inject(RunCoordinator) private readonly coordinator: RunCoordinator,
    @Inject(RunEventStreamService)
    private readonly events: RunEventStreamService,
  ) {}

  @Post("workflows/:workflowId/runs")
  @HttpCode(202)
  async create(
    @CurrentUser() user: PublicUser,
    @Param("workflowId", idPipe) workflowId: string,
    @Body(new ZodValidationPipe(CreateRunRequestSchema))
    input: CreateRunRequest,
  ) {
    return {
      success: true as const,
      data: await this.runs.createDebugRun(user.id, workflowId, input),
    };
  }

  @Get("runs/:id")
  async get(@CurrentUser() user: PublicUser, @Param("id", idPipe) id: string) {
    return { success: true as const, data: await this.runs.get(user.id, id) };
  }

  @Post("runs/:id/cancel")
  @HttpCode(200)
  async cancel(
    @CurrentUser() user: PublicUser,
    @Param("id", idPipe) id: string,
  ) {
    return {
      success: true as const,
      data: { status: await this.coordinator.cancel(user.id, id) },
    };
  }

  /** 所属校验先于 SSE 建流；Last-Event-ID 只接受一个十进制持久化游标。 */
  @Sse("runs/:id/events")
  async stream(
    @CurrentUser() user: PublicUser,
    @Param("id", idPipe) id: string,
    @Res({ passthrough: true }) response: Response,
    @Headers("last-event-id") rawCursor?: string | string[],
  ) {
    if (Array.isArray(rawCursor))
      throw new ApiError(400, "INVALID_EVENT_CURSOR", "事件游标无效");
    // 订阅后的失败按响应头是否已经提交处理，避免空 200 与合成 SSE 游标。
    const stream = this.events.stream(
      user.id,
      id,
      rawCursor,
      () => response.headersSent,
    );
    await this.events.assertOwned(user.id, id);
    return stream;
  }
}
