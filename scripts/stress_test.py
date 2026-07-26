#!/usr/bin/env python3
"""Invoke the subagent manager nine times and assert the concurrency boundary."""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone

import boto3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--function-name",
        default=os.environ.get("FUNCTION_NAME"),
        required="FUNCTION_NAME" not in os.environ,
    )
    parser.add_argument(
        "--orchestrator-id",
        default=os.environ.get("ORCHESTRATOR_ID", f"stress-{uuid.uuid4().hex[:12]}"),
    )
    parser.add_argument("--audit-bucket", default=os.environ.get("AUDIT_BUCKET_NAME"))
    parser.add_argument("--invocations", type=int, default=9)
    parser.add_argument("--expected-limit", type=int, default=8)
    return parser.parse_args()


def invoke(lambda_client, function_name: str, payload: dict) -> dict:
    response = lambda_client.invoke(
        FunctionName=function_name,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    result = json.loads(response["Payload"].read())
    if response.get("FunctionError"):
        raise RuntimeError(f"Lambda failed: {result}")
    return result


def main() -> int:
    args = parse_args()
    lambda_client = boto3.client("lambda")
    results = []

    for call_number in range(1, args.invocations + 1):
        result = invoke(
            lambda_client,
            args.function_name,
            {
                "action": "spawn",
                "orchestrator_id": args.orchestrator_id,
                "request_id": f"{args.orchestrator_id}-call-{call_number}",
            },
        )
        results.append(result)
        print(
            f"call={call_number} status={result.get('statusCode')} "
            f"body={json.dumps(result.get('body', {}), sort_keys=True)}",
            flush=True,
        )

    accepted = [item for item in results if item.get("statusCode") in (200, 201)]
    rejected = [item for item in results if item.get("statusCode") == 429]
    passed = (
        len(accepted) == args.expected_limit
        and len(rejected) == args.invocations - args.expected_limit
        and results[args.expected_limit].get("statusCode") == 429
    )
    report = {
        "test": "subagent_concurrency_limit",
        "orchestrator_id": args.orchestrator_id,
        "run_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "expected_limit": args.expected_limit,
        "invocations": args.invocations,
        "accepted": len(accepted),
        "rejected": len(rejected),
        "passed": passed,
        "results": results,
    }

    if args.audit_bucket:
        boto3.client("s3").put_object(
            Bucket=args.audit_bucket,
            Key=f"stress-tests/{args.orchestrator_id}.json",
            Body=json.dumps(report, indent=2, sort_keys=True).encode("utf-8"),
            ContentType="application/json",
            ServerSideEncryption="AES256",
        )

    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
