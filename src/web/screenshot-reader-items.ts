import type { TaskResultRun, TestTask } from "../shared/contracts";
import { parseScreenshotComparisonTitle } from "../shared/screenshot-comparison";
import { taskArtifactUrl } from "./api";

export interface ScreenshotReaderItem {
  key: string;
  url: string;
  title: string;
  label: string;
  subtitle?: string;
  alt?: string;
}

export function resultScreenshotItems(taskId: string, runs: TaskResultRun[]): ScreenshotReaderItem[] {
  return runs.flatMap(run => run.screenshots.map(artifact => {
    const page = run.targetPage.trim();
    const isSourcePath = /^(?:\.[\\/])?(?:tests?|specs?|__tests__)(?:[\\/]|$)|\.[cm]?[jt]sx?(?:$|[?#:])/i.test(page);
    const targetPage = isSourcePath ? "" : page;
    const title = parseScreenshotComparisonTitle(artifact.label, targetPage);
    const subtitle = targetPage && !title.includes(targetPage.replace(/^\/+/, "")) ? targetPage : undefined;
    return {
      // Tuple encoding avoids delimiter collisions across runs, cases and artifacts.
      key: JSON.stringify([taskId, run.runId, run.caseRunId, run.caseId, artifact.id]),
      url: taskArtifactUrl(taskId, artifact.id),
      title,
      label: artifact.label,
      subtitle,
      alt: `${title} ${artifact.label}`,
    };
  }));
}

export function liveScreenshotItems(task: Pick<TestTask, "id" | "artifacts">): ScreenshotReaderItem[] {
  return (task.artifacts ?? []).filter(artifact => artifact.role === "screenshot").map(artifact => ({
    key: JSON.stringify([task.id, artifact.id]),
    url: taskArtifactUrl(task.id, artifact.id),
    title: parseScreenshotComparisonTitle(artifact.label),
    label: artifact.label,
    subtitle: "运行中截图",
    alt: artifact.label,
  }));
}

export function survivingScreenshotKey(items: ScreenshotReaderItem[], selectedKey: string): string {
  return items.some(item => item.key === selectedKey) ? selectedKey : items[0]?.key ?? "";
}
