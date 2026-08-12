module.exports = {
  schemaVersion: "mobile-test-console.config.v1",
  project: {
    id: "mobile-test-console-demo",
    name: "控制台示例项目",
    root: "..",
  },
  deviceProviders: ["android"],
  lifecycle: {
    startup: {
      executable: "node",
      args: ["-e", "console.log('示例项目准备完成，服务进程 '+process.argv[1])", "{{process.pid}}"],
    },
  },
  tests: [
    {
      id: "demo-smoke",
      label: "示例 Smoke",
      description: "运行短暂的本机示例任务，用于检查调度、状态和日志展示。",
      platforms: ["android"],
      parameters: [
        {
          id: "duration",
          label: "运行时长",
          type: "select",
          defaultValue: "2000",
          options: [
            { value: "2000", label: "2 秒" },
            { value: "5000", label: "5 秒" },
          ],
        },
      ],
      commands: {
        default: {
          executable: "node",
          args: [
            "-e",
            "const duration={{params.duration}}; let step=0; const timer=setInterval(()=>{step+=1; console.log('demo step '+step); if(step*500>=duration){clearInterval(timer)}},500)",
          ],
        },
      },
    },
  ],
};
