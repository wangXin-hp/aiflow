import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { loadEnvironment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import { RunEventHub } from "./run-event-hub.js";
import { RunEventWriter } from "./run-event-writer.js";
import { RunCoordinator } from "./run-coordinator.js";
import { RUN_ENQUEUER } from "./run.service.js";
import { RunRecoveryService } from "./run-recovery.service.js";
import { RUN_EXECUTION_STORE } from "./run-execution.store.js";
import { runExecutionProviders } from "./run-execution.providers.js";

describe("run execution providers", () => {
  it("resolves explicit Nest dependencies and the coordinator alias", async () => {
    const recover = vi.fn().mockResolvedValue(0);
    const module = await Test.createTestingModule({
      providers: [
        ...runExecutionProviders,
        RunEventHub,
        RunEventWriter,
        { provide: PrismaService, useValue: {} },
        {
          provide: ConfigService,
          useValue: new ConfigService(
            loadEnvironment({
              NODE_ENV: "test",
              JWT_SECRET: "test-secret-at-least-thirty-two-characters",
            }),
          ),
        },
      ],
    })
      .overrideProvider(RUN_EXECUTION_STORE)
      .useValue({ recover })
      .compile();
    expect(module.get(RunCoordinator)).toBeInstanceOf(RunCoordinator);
    expect(module.get(RUN_ENQUEUER)).toBe(module.get(RunCoordinator));
    expect(module.get(RunRecoveryService)).toBeInstanceOf(RunRecoveryService);
    await module.init();
    expect(recover).toHaveBeenCalledOnce();
    await module.close();
  });
});
