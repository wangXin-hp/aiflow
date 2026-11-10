import { ConfigService } from "@nestjs/config";
import type { Provider } from "@nestjs/common";
import type { Environment } from "../config/environment.js";
import { RUN_ENQUEUER } from "./run.service.js";
import { RunAdaptersFactory } from "./run-adapters.factory.js";
import { RunCoordinator, RUN_EXECUTION_CONFIG } from "./run-coordinator.js";
import {
  PrismaRunExecutionStore,
  RUN_EXECUTION_STORE,
} from "./run-execution.store.js";
import { RunRecoveryService } from "./run-recovery.service.js";

/** 后续 RunModule 直接导入此组 provider，确保 tsx 模式也能解析显式依赖。 */
export const runExecutionProviders: Provider[] = [
  RunAdaptersFactory,
  { provide: RUN_EXECUTION_STORE, useClass: PrismaRunExecutionStore },
  {
    provide: RUN_EXECUTION_CONFIG,
    inject: [ConfigService],
    useFactory: (config: ConfigService<Environment, true>) => ({
      totalTimeoutMs: config.get("RUN_TOTAL_TIMEOUT_MS", { infer: true }),
      nodeTimeoutMs: config.get("RUN_NODE_TIMEOUT_MS", { infer: true }),
      maxConcurrent: config.get("RUN_MAX_CONCURRENT", { infer: true }),
      maxNodes: config.get("RUN_MAX_NODES", { infer: true }),
    }),
  },
  RunCoordinator,
  { provide: RUN_ENQUEUER, useExisting: RunCoordinator },
  RunRecoveryService,
];
