// Prefer the dedicated job-launcher IAM user keys. If they are absent, fall back
// to the standard AWS SDK credential chain (shared config, instance role, etc.).
export function awsClientOptions() {
  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.JOB_LAUNCHER_ACCESS_KEY;
  const secretAccessKey = process.env.JOB_LAUNCHER_SECRET_ACCESS_KEY;

  if (accessKeyId && secretAccessKey) {
    return {
      region,
      credentials: { accessKeyId, secretAccessKey },
    };
  }

  return { region };
}
