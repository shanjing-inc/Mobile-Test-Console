/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { buildResultBundle } = require("./result-bundle.cjs");

const PROVIDER_ID = "shanjing-example";
const CAPABILITIES = [
  "app.build",
  "app.install",
  "account.preflight",
  "page-parameters.resolve",
  "result.analysis",
];
const PREPARATION_CAPABILITIES = CAPABILITIES.filter(capability => capability !== "result.analysis");

module.exports = {
  apiVersion: "mobile-test-console.project-provider-plugin.v1",
  createProviders(context) {
    return [{
      id: PROVIDER_ID,
      manifest: {
        schemaVersion: "mobile-test-console.project-provider.v1",
        providerId: PROVIDER_ID,
        scope: {
          targetKinds: ["app"],
          runtimes: ["lynx"],
          platforms: ["android"],
        },
        capabilities: CAPABILITIES.map(id => ({ id, version: 1 })),
      },
      prepareRun(request) {
        const unsupported = request.capabilities.filter(capability => !PREPARATION_CAPABILITIES.includes(capability));
        if (unsupported.length > 0) throw new Error(`不支持准备能力: ${unsupported.join(",")}`);
        return {
          commands: [{
            executable: process.execPath,
            args: [
              "qa/prepare.cjs",
              "--capabilities", request.capabilities.join(","),
              "--platform", request.plan.device.platform,
              "--device", request.plan.device.id,
            ],
            cwd: context.project.root,
          }],
        };
      },
      collectResult(request) {
        if (request.signal.aborted) throw new Error("结果收集已取消");
        const projectRoot = request.plan.command?.cwd || context.project.root;
        return { bundle: buildResultBundle(path.resolve(projectRoot), request) };
      },
    }];
  },
};

module.exports.PROVIDER_ID = PROVIDER_ID;
module.exports.CAPABILITIES = CAPABILITIES;
module.exports.PREPARATION_CAPABILITIES = PREPARATION_CAPABILITIES;
