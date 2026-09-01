from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class SoftwareBuilderAdminTests(unittest.TestCase):
    def test_submit_requires_an_idea_and_defers_repository_creation(self) -> None:
        page = (ROOT / "admin/app/software/page.tsx").read_text(encoding="utf-8")

        self.assertIn('data-testid="software-idea"', page)
        self.assertIn("idea.trim().length === 0", page)
        self.assertIn("Will be created only when you click Submit.", page)
        self.assertLess(
            page.index('fetch("/api/github/repositories"'),
            page.index("requestJobLaunch("),
        )
        self.assertLess(
            page.index('fetch("/api/projects"'),
            page.index("requestJobLaunch("),
        )
        self.assertIn("project || undefined", page)

    def test_job_reservation_atomically_writes_repository_assignment(self) -> None:
        route = (ROOT / "admin/app/api/jobs/route.ts").read_text(encoding="utf-8")

        transaction = route.split("new TransactWriteCommand", 1)[1]
        self.assertIn("TableName: config.jobsTable", transaction)
        self.assertIn("TableName: config.repositoryAssignmentsTable", transaction)
        self.assertIn("github_repository_id: githubRepository.id", transaction)
        self.assertIn(
            "github_repository_full_name: githubRepository.fullName", transaction
        )
        self.assertIn("global_memory_project_name: projectName", transaction)
        self.assertNotIn("githubRepositoryFullName", route)

    def test_software_jobs_select_the_software_launch_template(self) -> None:
        route = (ROOT / "admin/app/api/jobs/route.ts").read_text(encoding="utf-8")

        self.assertIn(
            'typeOfJob === "software_builder"\n'
            "              ? config.softwareBuilderLaunchTemplateId",
            route,
        )
        self.assertIn('{ Key: "TypeOfJob", Value: typeOfJob }', route)

    def test_new_project_creation_writes_optional_markdown_description(self) -> None:
        route = (ROOT / "admin/app/api/projects/route.ts").read_text(
            encoding="utf-8"
        )

        self.assertIn("Key: `${parsed.name}/`", route)
        self.assertIn("Key: `${parsed.name}/description.md`", route)
        self.assertIn('ContentType: "text/markdown; charset=utf-8"', route)
        self.assertIn('IfNoneMatch: "*"', route)


if __name__ == "__main__":
    unittest.main()
