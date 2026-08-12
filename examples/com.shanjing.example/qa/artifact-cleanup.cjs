/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");

const REQUEST_SCHEMA = "mobile-test-console.artifact-cleanup-request.v1";
const RESULT_SCHEMA = "mobile-test-console.artifact-cleanup-result.v1";
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    result[argv[index].slice(2)] = argv[index + 1] || "";
    index += 1;
  }
  return result;
}

function loadRequest(filePath) {
  const request = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  if (request.schemaVersion !== REQUEST_SCHEMA) throw new Error("清理请求 schemaVersion 无效");
  if (!["plan", "apply"].includes(request.mode)) throw new Error("清理模式无效");
  for (const field of ["candidateRunIds", "protectedRunIds"]) {
    if (!Array.isArray(request[field]) || request[field].some(runId => typeof runId !== "string" || !RUN_ID_PATTERN.test(runId))) {
      throw new Error(`清理请求 ${field} 无效`);
    }
  }
  if (request.discoverCandidates !== undefined && typeof request.discoverCandidates !== "boolean") {
    throw new Error("清理请求 discoverCandidates 无效");
  }
  return {
    mode: request.mode,
    candidateRunIds: [...new Set(request.candidateRunIds)],
    protectedRunIds: [...new Set(request.protectedRunIds)],
    discoverCandidates: request.discoverCandidates === true,
  };
}

function matchesRun(name, runId) {
  return name === runId || name.startsWith(`${runId}-`);
}

function measure(directory) {
  const stack = [directory];
  let files = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) stack.push(target);
      else {
        files += 1;
        bytes += stat.size;
      }
    }
  }
  return { files, bytes };
}

function cleanup(request, artifactsRoot) {
  const protectedIds = new Set(request.protectedRunIds);
  const directories = fs.existsSync(artifactsRoot)
    ? fs.readdirSync(artifactsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    : [];
  const candidateRunIds = request.discoverCandidates ? [...directories].sort((left, right) => right.localeCompare(left)) : request.candidateRunIds;
  const candidates = [...candidateRunIds].sort((left, right) => right.length - left.length || left.localeCompare(right));
  const owners = new Map(directories.map(name => [name, candidates.find(runId => matchesRun(name, runId)) || ""]));
  const result = {
    schemaVersion: RESULT_SCHEMA,
    ok: true,
    mode: request.mode,
    artifactsRoot,
    items: [],
    files: 0,
    bytes: 0,
    filesRemoved: 0,
    bytesFreed: 0,
    skipped: [],
    errors: [],
  };

  for (const runId of candidateRunIds) {
    if (protectedIds.has(runId)) {
      result.items.push({ runId, relativePaths: [], files: 0, bytes: 0, status: "skipped", reason: "protected" });
      result.skipped.push({ runId, reason: "protected" });
      continue;
    }
    const names = directories.filter(name => owners.get(name) === runId
      && !request.protectedRunIds.some(protectedRunId => matchesRun(name, protectedRunId)));
    if (names.length === 0) {
      result.items.push({ runId, relativePaths: [], files: 0, bytes: 0, status: "missing", reason: "artifacts-not-found" });
      continue;
    }
    const measured = names.map(name => {
      const target = path.resolve(artifactsRoot, name);
      const relative = path.relative(artifactsRoot, target);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`产物路径越界: ${target}`);
      return { name, target, ...measure(target) };
    });
    const item = {
      runId,
      relativePaths: measured.map(entry => entry.name),
      files: measured.reduce((total, entry) => total + entry.files, 0),
      bytes: measured.reduce((total, entry) => total + entry.bytes, 0),
      status: request.mode === "plan" ? "planned" : "deleted",
      reason: "candidate",
    };
    result.files += item.files;
    result.bytes += item.bytes;
    if (request.mode === "apply") {
      for (const entry of measured) {
        fs.rmSync(entry.target, { recursive: true, force: true });
        result.filesRemoved += entry.files;
        result.bytesFreed += entry.bytes;
      }
    }
    result.items.push(item);
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.request || !args["artifacts-root"]) throw new Error("需要 --request 和 --artifacts-root");
  process.stdout.write(`${JSON.stringify(cleanup(loadRequest(args.request), path.resolve(args["artifacts-root"])))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
