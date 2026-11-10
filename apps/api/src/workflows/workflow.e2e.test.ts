import "reflect-metadata";
import { type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowResponseSchema, type WorkflowV2 } from "@aiflow/contracts";
import { configureHttpApplication } from "../common/http-application.js";
import { loadEnvironment, type Environment } from "../config/environment.js";
import { createDatabaseTestContext } from "../test/database-test-context.js";

const origin = "http://127.0.0.1:5173";
const secret = "workflow-http-test-secret-32-characters";
const definition: WorkflowV2 = {
  schemaVersion: 2,
  nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 } },
    {
      id: "end",
      type: "end",
      position: { x: 240, y: 0 },
      config: { values: {} },
    },
  ],
  edges: [
    {
      id: "start-end",
      source: "start",
      sourcePort: "output",
      target: "end",
      targetPort: "input",
    },
  ],
};
const invalidGraph: WorkflowV2 = {
  ...definition,
  edges: [],
};

describe("workflow HTTP boundary (real PostgreSQL)", () => {
  const database = createDatabaseTestContext();
  let app: INestApplication;
  let ownerId: string;
  let otherId: string;
  let ownerCookie: string;
  let otherCookie: string;

  beforeAll(async () => {
    await database.connect();
    const { AppModule } = await import("../app.module.js");
    const configuration = new ConfigService<Environment, true>(
      loadEnvironment({
        NODE_ENV: "test",
        DATABASE_URL:
          process.env.TEST_DATABASE_URL ??
          "postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow_test",
        JWT_SECRET: secret,
        WEB_PUBLIC_URL: origin,
      }),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(configuration)
      .compile();
    app = module.createNestApplication({ logger: false });
    configureHttpApplication(app);
    await app.init();
    ownerId = (await database.createUser("workflow-http-owner")).id;
    otherId = (await database.createUser("workflow-http-other")).id;
    const jwt = app.get(JwtService);
    ownerCookie = `aiflow_session=${await jwt.signAsync({ sub: ownerId }, { secret, expiresIn: 3600 })}`;
    otherCookie = `aiflow_session=${await jwt.signAsync({ sub: otherId }, { secret, expiresIn: 3600 })}`;
  }, 20000);

  afterAll(async () => {
    try {
      await database.cleanup();
    } finally {
      await app?.close();
      await database.close();
    }
  });

  it("requires authentication on every workflow route", async () => {
    for (const result of [
      request(app.getHttpServer()).get("/api/workflows"),
      request(app.getHttpServer()).get(`/api/workflows/${randomUUID()}`),
      request(app.getHttpServer())
        .post("/api/workflows")
        .send({ name: "x", definition }),
      request(app.getHttpServer())
        .patch(`/api/workflows/${randomUUID()}`)
        .send({ revision: 1, name: "x" }),
      request(app.getHttpServer()).delete(`/api/workflows/${randomUUID()}`),
    ])
      expect((await result).body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("creates, lists and reads only public workflow fields", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/workflows")
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ name: "HTTP draft", definition });
    expect(created.status).toBe(201);
    expect(created.body.success).toBe(true);
    expect(WorkflowResponseSchema.safeParse(created.body.data).success).toBe(
      true,
    );
    expect(Object.keys(created.body.data).sort()).toEqual([
      "createdAt",
      "definition",
      "description",
      "id",
      "name",
      "revision",
      "updatedAt",
    ]);
    const listed = await request(app.getHttpServer())
      .get("/api/workflows?limit=20")
      .set("Cookie", ownerCookie);
    expect(listed.status).toBe(200);
    expect(
      listed.body.data.items.map((item: { id: string }) => item.id),
    ).toContain(created.body.data.id);
    const detail = await request(app.getHttpServer())
      .get(`/api/workflows/${created.body.data.id}`)
      .set("Cookie", ownerCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toEqual(created.body.data);
  });

  it("rejects invalid graph and malformed request boundaries without persisting", async () => {
    const before = await database.prisma.workflow.count({ where: { ownerId } });
    const graph = await request(app.getHttpServer())
      .post("/api/workflows")
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ name: "bad", definition: invalidGraph });
    expect(graph.status).toBe(400);
    expect(graph.body).toMatchObject({
      code: "WORKFLOW_GRAPH_INVALID",
      details: expect.any(Array),
    });
    expect(await database.prisma.workflow.count({ where: { ownerId } })).toBe(
      before,
    );
    const badCursor = await request(app.getHttpServer())
      .get("/api/workflows?cursor=invalid")
      .set("Cookie", ownerCookie);
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.code).toBe("VALIDATION_ERROR");
    const invalidRevision = await request(app.getHttpServer())
      .patch(`/api/workflows/${randomUUID()}`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ revision: 0, name: "bad" });
    expect(invalidRevision.status).toBe(400);
    expect(invalidRevision.body.code).toBe("VALIDATION_ERROR");
  });

  it("maps stale writes, archive and cross-owner IDs without leaking ownership", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/workflows")
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ name: "initial", description: "old", definition });
    const id = created.body.data.id as string;
    const changed = await request(app.getHttpServer())
      .patch(`/api/workflows/${id}`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ revision: 1, name: "current" });
    expect(changed.status).toBe(200);
    expect(changed.body.data.revision).toBe(2);
    const stale = await request(app.getHttpServer())
      .patch(`/api/workflows/${id}`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ revision: 1, name: "stale", description: "wrong" });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("WORKFLOW_REVISION_CONFLICT");
    expect(
      await database.prisma.workflow.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ name: "current", description: "old", revision: 2 });
    const unknown = randomUUID();
    for (const method of ["get", "patch", "delete"] as const) {
      const run = async (target: string) => {
        const client = request(app.getHttpServer());
        const pending = client[method](`/api/workflows/${target}`).set(
          "Cookie",
          otherCookie,
        );
        if (method === "patch")
          pending
            .set("Origin", origin)
            .send({ revision: 2, name: "forbidden" });
        if (method === "delete") pending.set("Origin", origin);
        return pending;
      };
      const cross = await run(id);
      const missing = await run(unknown);
      expect(cross.status).toBe(404);
      expect(cross.body).toEqual(missing.body);
      expect(cross.body.code).toBe("WORKFLOW_NOT_FOUND");
    }
    for (let i = 0; i < 2; i++) {
      const archived = await request(app.getHttpServer())
        .delete(`/api/workflows/${id}`)
        .set("Cookie", ownerCookie)
        .set("Origin", origin);
      expect(archived.status).toBe(204);
    }
    const hidden = await request(app.getHttpServer())
      .get(`/api/workflows/${id}`)
      .set("Cookie", ownerCookie);
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe("WORKFLOW_NOT_FOUND");
  });
});
