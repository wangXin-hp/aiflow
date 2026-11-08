import { Module } from "@nestjs/common";
import { HealthController } from "./health.js";
@Module({ controllers: [HealthController] })
export class AppModule {}
