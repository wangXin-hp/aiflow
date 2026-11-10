import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { loadEnvironment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import { RunEventHub } from "./run-event-hub.js";
import { RunEventWriter } from "./run-event-writer.js";
import { RunCoordinator } from "./run-coordinator.js";
import { runExecutionProviders } from "./run-execution.providers.js";

describe("run execution providers", () => {
  it("resolves explicit Nest dependencies and the coordinator alias", async () => {
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
    }).compile();
    expect(module.get(RunCoordinator)).toBeInstanceOf(RunCoordinator);
    await module.close();
  });
});
