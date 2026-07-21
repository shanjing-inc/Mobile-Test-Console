import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConsoleSnapshot, StartTasksRequest } from "../shared/contracts.js";
import { toPublicTests, type LoadedProjectConfig } from "./config.js";
import type { DeviceDiscoveryService } from "./devices.js";
import { ConsoleError } from "./errors.js";
import type { TaskManager } from "./task-manager.js";

const startRequestSchema = z.object({
  testId: z.string().min(1),
  deviceKeys: z.array(z.string().min(1)).min(1),
  parameters: z.record(z.string()).default({}),
});

export interface CreateAppOptions {
  config: LoadedProjectConfig;
  devices: DeviceDiscoveryService;
  tasks: TaskManager;
  staticDir?: string;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/snapshot", async (): Promise<ConsoleSnapshot> => {
    const discovery = await options.devices.discover();
    return {
      project: options.config.project,
      devices: discovery.devices,
      deviceErrors: discovery.errors,
      tests: toPublicTests(options.config.tests),
      tasks: options.tasks.list(),
      updatedAt: new Date().toISOString(),
    };
  });

  app.post<{ Body: StartTasksRequest }>("/api/tasks", async request => {
    const parsed = startRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ConsoleError(
        "REQUEST_INVALID",
        parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    const discovery = await options.devices.discover();
    return { tasks: await options.tasks.start(parsed.data, discovery.devices) };
  });

  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/stop", async request => ({
    task: await options.tasks.stop(request.params.taskId),
  }));

  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof ConsoleError;
    const statusCode = known ? error.statusCode : 500;
    reply.status(statusCode).send({
      error: {
        code: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "控制服务发生内部错误",
      },
    });
  });

  if (options.staticDir && fs.existsSync(options.staticDir)) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.status(404).send({ error: { code: "NOT_FOUND", message: "API 不存在" } });
        return;
      }
      reply.type("text/html").send(fs.createReadStream(path.join(options.staticDir!, "index.html")));
    });
  }

  return app;
}
