/**
 * The setup advisor.
 *
 * A business owner opening the admin panel for the first time has a working installation
 * and no idea what is wrong with it. Everything is technically valid — the tenant exists,
 * the settings row has defaults — and yet the assistant answers nothing, because there is
 * no content and no allowed origin. Nothing in the product tells them that.
 *
 * This is pure inspection, deliberately: it reads a snapshot of the tenant's state and
 * returns findings. No model is involved, so it works in `static` mode, works with no
 * provider configured at all, and costs nothing to run on every page load. The owner asked
 * for an assistant that helps set QuidChat up including when QuidChat is used without AI —
 * an advisor that needed AI to explain how to avoid AI would be a poor joke.
 */

export type SetupSeverity = "blocker" | "warning" | "suggestion"

export type SetupFinding = {
  id: string
  severity: SetupSeverity
  /** What is wrong, in the owner's terms rather than the schema's. */
  title: string
  /** Why it matters. Without this a finding reads as nagging. */
  why: string
  /** The concrete next action. A finding that does not say what to do is just bad news. */
  fix: string
}

export type SetupSnapshot = {
  allowedOrigins: string[]
  sourceCount: number
  readySourceCount: number
  erroredSourceCount: number
  chunkCount: number
  approvedCannedAnswerCount: number
  draftCannedAnswerCount: number
  answerMode: "static" | "thrifty" | "full"
  monthlyBudgetCents: number
  spentThisMonthCents: number
  escalationsNoSource: number
  hasProvider: boolean
  highRiskTopics: string[]
  refusalText: string
}

/**
 * Findings, most urgent first.
 *
 * Ordering is part of the design: a first-time owner reads the top of a list and stops.
 * Blockers are things that make the assistant answer nothing at all, so they come first
 * even when a warning is more interesting.
 */
export function adviseSetup(snapshot: SetupSnapshot): SetupFinding[] {
  const findings: SetupFinding[] = []
  const {
    allowedOrigins, sourceCount, readySourceCount, erroredSourceCount, chunkCount,
    approvedCannedAnswerCount, draftCannedAnswerCount, answerMode,
    monthlyBudgetCents, spentThisMonthCents, escalationsNoSource, hasProvider,
    highRiskTopics, refusalText,
  } = snapshot

  // --- Blockers: the assistant cannot answer anybody at all ---

  if (allowedOrigins.length === 0) {
    findings.push({
      id: "no-allowed-origins",
      severity: "blocker",
      title: "The widget is refused on every site",
      why:
        "An empty origin list is not treated as 'allow everything' — that would expose a " +
        "brand new business to any site that guessed its name. So right now every request " +
        "from every page is rejected.",
      fix: "Add the address of the site the widget will live on, e.g. https://yourshop.com",
    })
  }

  if (answerMode === "static") {
    if (approvedCannedAnswerCount === 0) {
      findings.push({
        id: "static-mode-no-approved-answers",
        severity: "blocker",
        title: "Static mode is on, but no answer has been approved",
        why:
          "In static mode the assistant replies only from answers you have approved, and " +
          "never calls a model. With none approved it can only decline." +
          (draftCannedAnswerCount > 0
            ? ` You have ${draftCannedAnswerCount} draft${draftCannedAnswerCount === 1 ? "" : "s"} waiting — drafts are deliberately ignored so nothing reaches a customer before you have read it.`
            : ""),
        fix:
          draftCannedAnswerCount > 0
            ? "Review your drafts and approve the ones you are happy for customers to see"
            : "Write a few common questions and answers, then approve them",
      })
    }
  } else {
    if (sourceCount === 0) {
      findings.push({
        id: "no-sources",
        severity: "blocker",
        title: "There is nothing to answer from",
        why:
          "The assistant only says things it can trace to a document you supplied. With no " +
          "documents, every question is declined — which is correct behaviour, but not useful yet.",
        fix: "Add your policies, product details or FAQ as a text source",
      })
    } else if (chunkCount === 0) {
      findings.push({
        id: "sources-not-indexed",
        severity: "blocker",
        title: "Your content has not finished indexing",
        why:
          "The documents are stored but not yet searchable, so the assistant cannot find " +
          "anything in them.",
        fix: "Check the source list for an error message, then re-index",
      })
    }

    if (!hasProvider) {
      findings.push({
        id: "no-provider",
        severity: "blocker",
        title: "No AI provider is configured",
        why:
          "This answer mode needs a provider to read your documents and reply. Nothing will " +
          "work until one is set.",
        fix:
          "Set a provider key in the environment — OPENAI_API_KEY is the simplest — or switch " +
          "to static mode, which answers from approved text and needs no provider at all",
      })
    }
  }

  // --- Warnings: it works, but something is quietly wrong ---

  if (erroredSourceCount > 0) {
    findings.push({
      id: "errored-sources",
      severity: "warning",
      title: `${erroredSourceCount} source${erroredSourceCount === 1 ? "" : "s"} failed to index`,
      why:
        "Their text was kept, so keyword search can still find it, but the assistant cannot " +
        "match them by meaning. Answers about those documents will be worse than they should be.",
      fix: "Open the source to see why it failed, then re-index it",
    })
  }

  if (monthlyBudgetCents > 0 && spentThisMonthCents >= monthlyBudgetCents) {
    findings.push({
      id: "budget-exhausted",
      severity: "blocker",
      title: "This month's spending limit has been reached",
      why:
        "The assistant is declining every question to avoid spending more. Customers see a " +
        "polite refusal, not an error, so nothing looks broken from their side.",
      fix: "Raise the monthly limit, or switch to static mode until next month",
    })
  } else if (
    monthlyBudgetCents > 0 &&
    spentThisMonthCents >= Math.floor(monthlyBudgetCents * 0.8)
  ) {
    findings.push({
      id: "budget-nearly-exhausted",
      severity: "warning",
      title: "You are close to this month's spending limit",
      why: "At the limit the assistant stops answering, so it is better to know now.",
      fix: "Review the limit, or consider thrifty mode which retrieves without generating",
    })
  }

  if (escalationsNoSource >= 5) {
    findings.push({
      id: "many-no-source-escalations",
      severity: "warning",
      title: `${escalationsNoSource} questions had no source to answer from`,
      why:
        "Customers are asking things your documents do not cover. This is the most useful " +
        "signal you have about what to write next.",
      fix: "Open Escalations, read the questions, and add the missing information",
    })
  }

  if (monthlyBudgetCents === 0 && answerMode === "full") {
    findings.push({
      id: "no-budget-limit",
      severity: "warning",
      title: "There is no spending limit",
      why:
        "Zero means unlimited, not zero. A busy day, or a page that reloads the widget in a " +
        "loop, can cost more than you expect before you notice.",
      fix: "Set a monthly limit you would be comfortable spending",
    })
  }

  // --- Suggestions: it is fine, and could be better ---

  if (highRiskTopics.length === 0) {
    findings.push({
      id: "no-high-risk-topics",
      severity: "suggestion",
      title: "No topics are marked high-risk",
      why:
        "High-risk topics are always treated as claims about your business, so they must cite " +
        "a document even if the model thought it was making small talk. Prices and warranties " +
        "are where a confident guess costs you most.",
      fix: "Add the topics you never want guessed — price, warranty, stock, refunds",
    })
  }

  if (refusalText.trim().length === 0) {
    findings.push({
      id: "empty-refusal-text",
      severity: "warning",
      title: "The refusal message is empty",
      why: "When the assistant has no answer, the customer will see nothing at all.",
      fix: "Write what you want customers to see, and how to reach a person",
    })
  }

  if (answerMode === "full" && readySourceCount > 0 && approvedCannedAnswerCount === 0) {
    findings.push({
      id: "consider-canned-answers",
      severity: "suggestion",
      title: "Your most common questions could be answered for free",
      why:
        "Approved answers are matched before the model is called, so the questions you are " +
        "asked most often cost nothing and reply instantly.",
      fix: "Write approved answers for your top few questions",
    })
  }

  const order: Record<SetupSeverity, number> = { blocker: 0, warning: 1, suggestion: 2 }
  return findings.toSorted((a, b) => order[a.severity] - order[b.severity])
}

/** True when nothing is blocking the assistant from answering. */
export function isReadyToAnswer(findings: SetupFinding[]): boolean {
  return !findings.some((f) => f.severity === "blocker")
}
