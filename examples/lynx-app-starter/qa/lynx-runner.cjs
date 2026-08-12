/* eslint-disable @typescript-eslint/no-require-imports */
const provider = require("./lynx-project-provider.cjs");

module.exports = {
  apiVersion: "mobile-test-console.runner-plugin.v1",
  createRunners(context) {
    context.services.requireProjectProvider(provider.PROVIDER_ID, provider.CAPABILITIES);
    return [context.services.createProviderCommandRunner(
      "lynx-app-starter-runner",
      provider.PROVIDER_ID,
      provider.PREPARATION_CAPABILITIES,
    )];
  },
};
