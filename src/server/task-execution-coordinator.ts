interface ScheduledTask {
  id: string;
  run: () => Promise<void>;
}

export class TaskExecutionCoordinator {
  private readonly activeResources = new Set<string>();
  private readonly queues = new Map<string, ScheduledTask[]>();

  schedule(resourceKey: string, taskId: string, run: () => Promise<void>): void {
    const queue = this.queues.get(resourceKey) ?? [];
    queue.push({ id: taskId, run });
    this.queues.set(resourceKey, queue);
    this.drain(resourceKey);
  }

  cancel(taskId: string): void {
    for (const [resourceKey, queue] of this.queues) {
      const next = queue.filter(task => task.id !== taskId);
      if (next.length === 0) this.queues.delete(resourceKey);
      else if (next.length !== queue.length) this.queues.set(resourceKey, next);
    }
  }

  private drain(resourceKey: string): void {
    if (this.activeResources.has(resourceKey)) return;
    const queue = this.queues.get(resourceKey);
    const task = queue?.shift();
    if (!task) {
      this.queues.delete(resourceKey);
      return;
    }
    if (queue!.length === 0) this.queues.delete(resourceKey);
    this.activeResources.add(resourceKey);
    queueMicrotask(() => {
      void task.run().finally(() => {
        this.activeResources.delete(resourceKey);
        this.drain(resourceKey);
      });
    });
  }
}
