import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

describe("CI concurrency", () => {
  it("supersedes old main and PR checks without cancelling merge-queue checks", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on).toHaveProperty("merge_group");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' || github.event_name == 'push' }}",
    );
  });

  it("keeps each PR and merge-queue group separate from main", () => {
    expect(workflow.concurrency.group).toBe(
      "ci-${{ github.event_name == 'merge_group' && github.event.merge_group.head_ref || github.ref }}",
    );
  });
});
