import { NextRequest, NextResponse } from "next/server";

import {
  GITHUB_REPOSITORY_DESCRIPTION_MAX_LENGTH,
  repositoryNameError,
} from "@/lib/github-repository-types";
import {
  createOrganizationRepository,
  GitHubApiError,
  GitHubConfigurationError,
  listOrganizationRepositories,
} from "@/lib/github-repositories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function publicError(error: unknown, action: "listed" | "created") {
  if (error instanceof GitHubConfigurationError) {
    return { status: 503, message: error.message };
  }
  if (error instanceof GitHubApiError) {
    if (error.upstreamStatus === 404) {
      return {
        status: 503,
        message:
          "The GitHub App installation was not found for this organization. Install the App and try again.",
      };
    }
    if (
      error.upstreamStatus === 422 &&
      /already exists|already_exists/i.test(error.message)
    ) {
      return {
        status: 409,
        message: "A repository with that name already exists in the organization.",
      };
    }
    if (error.upstreamStatus === 401 || error.upstreamStatus === 403) {
      return {
        status: 502,
        message:
          "GitHub rejected the App credentials or permissions. Check the App installation and permissions.",
      };
    }
    return {
      status: error.upstreamStatus === 422 ? 422 : 502,
      message: `The repository could not be ${action}: ${error.message}`,
    };
  }
  return {
    status: 500,
    message: `The repository could not be ${action}.`,
  };
}

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = request.headers.get("x-forwarded-host");
    const host = forwardedHost ?? request.headers.get("host");
    return Boolean(host) && originUrl.host === host;
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    return json(await listOrganizationRepositories());
  } catch (error) {
    console.error("GitHub repository listing failed", error);
    const response = publicError(error, "listed");
    return json({ error: response.message }, { status: response.status });
  }
}

export async function POST(request: NextRequest) {
  // This prevents cross-site browser submissions. The admin deployment still needs
  // its normal user authentication before this endpoint is exposed publicly.
  if (!sameOrigin(request)) {
    return json({ error: "Cross-origin repository creation is not allowed." }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "The repository request must be valid JSON." }, { status: 400 });
  }

  if (typeof payload !== "object" || payload === null) {
    return json({ error: "Repository details are required." }, { status: 400 });
  }
  const input = payload as Record<string, unknown>;
  if (typeof input.name !== "string") {
    return json({ error: "Enter a repository name." }, { status: 400 });
  }
  const name = input.name.trim();
  const invalidName = repositoryNameError(name);
  if (invalidName) return json({ error: invalidName }, { status: 400 });

  if (input.description !== undefined && typeof input.description !== "string") {
    return json({ error: "The repository description must be text." }, { status: 400 });
  }
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > GITHUB_REPOSITORY_DESCRIPTION_MAX_LENGTH) {
    return json(
      {
        error: `Repository descriptions must be ${GITHUB_REPOSITORY_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
      },
      { status: 400 },
    );
  }

  try {
    return json(
      await createOrganizationRepository({ name, description }),
      { status: 201 },
    );
  } catch (error) {
    console.error("GitHub repository creation failed", error);
    const response = publicError(error, "created");
    return json({ error: response.message }, { status: response.status });
  }
}
