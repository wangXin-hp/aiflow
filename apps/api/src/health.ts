import { Controller, Get } from "@nestjs/common";
import type { HealthResponse } from "@aiflow/contracts";
import { Public } from "./auth/public.decorator.js";
@Controller("health")
export class HealthController {
  @Get()
  @Public()
  getHealth(): HealthResponse {
    return { status: "ok", service: "api" };
  }
}
