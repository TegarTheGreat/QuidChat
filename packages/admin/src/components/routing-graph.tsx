import * as React from "react"
import { Badge } from "./ui/badge"
import type { RoutingRule, Skill } from "../lib/api"

/**
 * What happens to an incoming message, drawn.
 *
 * A list of rules with a `position` column is technically complete and practically unreadable:
 * the thing that decides an outcome is the *order*, and order is exactly what a table asks you to
 * simulate in your head. Numbering is used here because these genuinely are a sequence — the
 * router walks them in order and the first match returns — not because numbers look organised.
 *
 * The layout is deliberately a ladder rather than a free canvas. A free canvas invites arranging
 * boxes, which encodes nothing; the ladder encodes the one thing that is true at runtime, which
 * is that rule 2 only ever runs because rule 1 did not match.
 *
 * Three things the table could not tell an owner, all read off `router.ts`:
 *
 *   - A `fallback` rule returns unconditionally, so **every rule below an enabled fallback is
 *     dead**. An owner who adds a keyword rule at the bottom will never see it fire and has no
 *     way to find out why.
 *   - `semantic` and `llm` rules are accepted by the form and skipped by the router — they are
 *     deferred. Silently never matching is the worst possible version of "not built yet".
 *   - A skill no rule points at is only reachable when another skill hands off to it.
 */

import { buildRows, ROW, TOP } from "./routing-graph-logic.js"

function ruleSummary(rule: RoutingRule): string {
  if (rule.kind === "fallback") return "Everything else"
  if (rule.kind === "keyword") return rule.pattern ? `Contains “${rule.pattern}”` : "No keyword set"
  return rule.kind === "semantic" ? "Similar in meaning" : "Decided by the model"
}

export function RoutingGraph({
  skills,
  rules,
}: {
  skills: Skill[]
  rules: RoutingRule[]
}): React.ReactElement {
  const rows = React.useMemo(() => buildRows(rules, skills), [rules, skills])
  const targeted = new Set(rows.filter((r) => !r.unreachable).map((r) => r.rule.skillId))
  const handoffOnly = skills.filter((s) => s.enabled && !targeted.has(s.id))
  const height = Math.max(rows.length, 1) * ROW + TOP * 2

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No rules yet. Every message is answered directly, without choosing a skill.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="relative grid grid-cols-[minmax(0,1fr)_64px_minmax(0,1fr)] gap-0">
        {/* The ladder: one row per rule, in the order the router walks them. */}
        <ol className="space-y-3" style={{ paddingTop: TOP }}>
          {rows.map((row, i) => (
            <li
              key={row.rule.id}
              className={`flex h-16 items-center gap-3 rounded-lg border px-3 ${
                row.unreachable || !row.rule.enabled
                  ? "border-dashed bg-muted/40 opacity-60"
                  : "bg-card"
              }`}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted font-mono text-xs tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{ruleSummary(row.rule)}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">{row.rule.kind}</span>
                  {!row.rule.enabled && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      off
                    </Badge>
                  )}
                  {row.notImplemented && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      not built yet
                    </Badge>
                  )}
                  {row.unreachable && (
                    <Badge variant="destructive" className="h-4 px-1 text-[10px]">
                      never reached
                    </Badge>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>

        {/* Connectors. Drawn rather than implied: which rule leads to which skill is the whole
            question, and an arrow answers it without the reader matching names down two lists. */}
        <svg
          className="pointer-events-none"
          width="64"
          height={height}
          viewBox={`0 0 64 ${height}`}
          aria-hidden="true"
        >
          {rows.map((row, i) => {
            const y = TOP + i * ROW + 32
            const target = skills.findIndex((s) => s.id === row.rule.skillId)
            const ty = target < 0 ? y : TOP + target * ROW + 32
            const dim = row.unreachable || !row.rule.enabled
            return (
              <path
                key={row.rule.id}
                d={`M0 ${y} C 28 ${y}, 36 ${ty}, 64 ${ty}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={dim ? 1 : 1.5}
                strokeDasharray={dim ? "3 3" : undefined}
                className={dim ? "text-muted-foreground/40" : "text-muted-foreground"}
              />
            )
          })}
        </svg>

        <ul className="space-y-3" style={{ paddingTop: TOP }}>
          {skills.map((skill) => (
            <li
              key={skill.id}
              className={`flex h-16 items-center gap-3 rounded-lg border px-3 ${
                skill.enabled ? "bg-card" : "border-dashed bg-muted/40 opacity-60"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{skill.name}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {skill.isFallback && (
                    <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                      fallback
                    </Badge>
                  )}
                  {skill.answerMode && (
                    <span className="text-xs text-muted-foreground">{skill.answerMode}</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {skill.sources.length} source{skill.sources.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {handoffOnly.length > 0 && (
        // Not an error — a skill can legitimately exist only to receive handoffs. But an owner
        // who thinks they routed to it deserves to see that no rule does.
        <p className="text-xs text-muted-foreground">
          No rule leads to{" "}
          <span className="font-medium text-foreground">
            {handoffOnly.map((s) => s.name).join(", ")}
          </span>
          . These are reachable only when another skill hands a question over.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Rules run top to bottom, and the first match wins. Beyond that, the skill answering can
        hand a question to another one when it turns out not to be its subject.
      </p>
    </div>
  )
}
