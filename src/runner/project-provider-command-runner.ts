import { CommandTaskRunner } from "./legacy-task-runner.js";
import {
  assertProjectProviderCapabilities,
  type ProjectProvider,
  validateProjectProvider,
  validateProjectProviderResultCollection,
  validateProjectProviderRunPreparation,
} from "./project-provider.js";
import {
  createRunnerEvent,
  type InProcessRunner,
  type RunPlan,
  type RunnerContext,
  type RunnerResult,
  validateRunnerId,
} from "./sdk.js";

export interface ProjectProviderResultSink {
  ingest(bundle: unknown, source?: string, expected?: {
    runId: string;
    projectId: string;
    status: "passed" | "failed";
  }): Promise<{
    resultUri: string;
    status: string;
    fingerprint: string;
  }>;
}

export class ProjectProviderCommandRunner implements InProcessRunner {
  readonly id: string;
  private readonly commandRunner: CommandTaskRunner;
  private readonly capabilities: readonly string[];

  constructor(
    id: string,
    private readonly provider: ProjectProvider,
    requiredCapabilities: readonly string[],
    private readonly resultSink?: ProjectProviderResultSink,
  ) {
    validateRunnerId(id);
    validateProjectProvider(provider);
    assertProjectProviderCapabilities(provider, requiredCapabilities);
    if (typeof provider.prepareRun !== "function") {
      throw new Error(`项目 Provider 缺少 prepareRun(): ${provider.id}`);
    }
    if (typeof provider.collectResult === "function" && !resultSink) {
      throw new Error(`项目 Provider 缺少结果存储: ${provider.id}`);
    }
    this.id = id;
    this.capabilities = Object.freeze([...requiredCapabilities]);
    this.commandRunner = new CommandTaskRunner(id);
  }

  async run(plan: RunPlan, context: RunnerContext): Promise<RunnerResult> {
    let preparation: unknown;
    try {
      preparation = await this.provider.prepareRun!({
        plan: Object.freeze(structuredClone(plan)),
        capabilities: this.capabilities,
      });
      validateProjectProviderRunPreparation(preparation);
    } catch (error) {
      return this.collect(plan, context, this.failed(plan.runId, context, error));
    }

    context.emit(createRunnerEvent(plan.runId, "capability", {
      source: "runner",
      message: "项目能力准备开始",
      data: { providerId: this.provider.id, capabilities: this.capabilities },
    }));
    for (const command of preparation.commands) {
      const result = await this.commandRunner.run({ ...plan, command: structuredClone(command) }, context);
      if (result.status !== "passed") return this.collect(plan, context, result);
    }
    context.emit(createRunnerEvent(plan.runId, "capability", {
      source: "runner",
      message: "项目能力准备完成",
      data: { providerId: this.provider.id, capabilities: this.capabilities },
    }));
    return this.collect(plan, context, await this.commandRunner.run(plan, context));
  }

  cancel(runId: string): void {
    this.commandRunner.cancel(runId);
  }

  shutdown(): Promise<void> {
    return this.commandRunner.shutdown();
  }

  private failed(runId: string, context: RunnerContext, error: unknown): RunnerResult {
    const message = error instanceof Error ? error.message : String(error);
    context.emit(createRunnerEvent(runId, "error", {
      source: "runner",
      level: "error",
      message: `项目能力准备失败: ${message}`,
    }));
    return { runId, status: "failed", exitCode: null, error: message };
  }

  private async collect(
    plan: RunPlan,
    context: RunnerContext,
    runnerResult: RunnerResult,
  ): Promise<RunnerResult> {
    if (runnerResult.status === "cancelled" || !this.provider.collectResult || !this.resultSink) {
      return runnerResult;
    }
    if (context.signal.aborted) return { ...runnerResult, status: "cancelled" };

    try {
      context.emit(createRunnerEvent(plan.runId, "capability", {
        source: "runner",
        message: "项目结果分析开始",
        data: { providerId: this.provider.id, capability: "result.analysis" },
      }));
      const collection = await this.provider.collectResult({
        plan: Object.freeze(structuredClone(plan)),
        result: Object.freeze(structuredClone(runnerResult)),
        signal: context.signal,
      });
      if (context.signal.aborted) return { ...runnerResult, status: "cancelled" };
      validateProjectProviderResultCollection(collection);
      const ingestion = await this.resultSink.ingest(
        collection.bundle,
        `项目 Provider ${this.provider.id}`,
        {
          runId: plan.runId,
          projectId: plan.projectId,
          status: runnerResult.status,
        },
      );
      if (context.signal.aborted) return { ...runnerResult, status: "cancelled" };
      context.emit(createRunnerEvent(plan.runId, "result", {
        source: "runner",
        message: "项目结果分析完成",
        data: {
          providerId: this.provider.id,
          capability: "result.analysis",
          resultUri: ingestion.resultUri,
          ingestionStatus: ingestion.status,
        },
      }));
      return {
        ...runnerResult,
        resultUri: ingestion.resultUri,
        metadata: {
          ...runnerResult.metadata,
          resultAnalysis: {
            providerId: this.provider.id,
            ingestionStatus: ingestion.status,
            fingerprint: ingestion.fingerprint,
          },
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `项目结果分析失败: ${detail}`;
      context.emit(createRunnerEvent(plan.runId, "error", {
        source: "runner",
        level: "error",
        message,
      }));
      return {
        ...runnerResult,
        status: "failed",
        error: runnerResult.error ? `${runnerResult.error}; ${message}` : message,
      };
    }
  }
}
