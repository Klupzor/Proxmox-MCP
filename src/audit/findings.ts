export type Severity = "high" | "medium" | "low";

export interface Finding {
  severity: Severity;
  target: string;
  rule: string;
  issue: string;
  fix: string;
}

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function summarize(findings: Finding[]) {
  const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return {
    summary: {
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length,
    },
    findings: sorted,
  };
}
