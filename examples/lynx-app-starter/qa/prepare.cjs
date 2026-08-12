/* eslint-disable @typescript-eslint/no-require-imports */
const { readArgs, requireArg } = require("./cli-args.cjs");

const args = readArgs(process.argv.slice(2));
const capabilities = requireArg(args, "capabilities").split(",");
const platform = requireArg(args, "platform");
const device = requireArg(args, "device");

for (const capability of capabilities) {
  process.stdout.write(`[starter] ${capability} ${platform}/${device}\n`);
}

process.stdout.write("[starter] 请在 qa/prepare.cjs 中接入项目真实的构建、安装、账号和页面参数命令\n");
