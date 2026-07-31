export type StressTestCall = {
  call: number;
  status: number;
  body: unknown;
};

export type StressTestReport = {
  test: "subagent_concurrency_limit";
  orchestratorId: string;
  runAt: string;
  expectedLimit: number;
  invocations: number;
  accepted: number;
  rejected: number;
  passed: boolean;
  calls: StressTestCall[];
};

export type StressTestLaunch = {
  orchestratorId: string;
  instanceId: string;
  startedAt: string;
  expectedLimit: number;
  invocations: number;
};

export type StressTestError = {
  error: string;
};
