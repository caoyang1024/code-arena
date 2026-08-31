/**
 * JSON Schema handed to the gatekeeper via `thread.run(prompt, { outputSchema })`.
 *
 * This is what makes the automatic loop possible: the verdict comes back as data,
 * not as prose we would have to guess at. Codex writes the schema to a temp file and
 * passes it to `codex exec --output-schema`, so the shape is enforced by the CLI.
 */
export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "request_changes"],
      description:
        "approve only if you would merge this as-is. Any blocker or major finding means request_changes.",
    },
    summary: {
      type: "string",
      description: "Two sentences at most: what was reviewed and why the verdict is what it is.",
    },
    findings: {
      type: "array",
      description:
        "Concrete defects. Empty when approving. Do not pad with style nits or speculation.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "issue", "evidence", "suggestion"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          file: { type: ["string", "null"], description: "Repo-relative path, or null." },
          line: { type: ["integer", "null"], description: "1-indexed line, or null." },
          issue: { type: "string", description: "One sentence stating the defect." },
          evidence: {
            type: "string",
            description:
              "Concrete inputs or state that trigger it, or the code you read that proves it. Not a restatement of the issue.",
          },
          suggestion: { type: "string", description: "What the implementer should change." },
        },
      },
    },
  },
} as const;

export function parseReview(raw: string): import("./types.js").Review {
  let text = raw.trim();
  // codex returns bare JSON under --output-schema, but tolerate a fenced block.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();

  const data = JSON.parse(text) as unknown;
  if (typeof data !== "object" || data === null) {
    throw new Error("Gatekeeper returned a non-object verdict");
  }
  const obj = data as Record<string, unknown>;
  if (obj.verdict !== "approve" && obj.verdict !== "request_changes") {
    throw new Error(`Gatekeeper returned an unknown verdict: ${JSON.stringify(obj.verdict)}`);
  }
  return {
    verdict: obj.verdict,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    findings: Array.isArray(obj.findings) ? (obj.findings as import("./types.js").Finding[]) : [],
  };
}
