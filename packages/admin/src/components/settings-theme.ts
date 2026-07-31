/**
 * Merges the widget fields this form edits over everything already stored.
 *
 * Kept apart from the dialog so the rule can be tested without rendering: it is a claim about not
 * losing data, not about layout.
 */
export function mergeWidgetTheme(
  stored: Record<string, unknown>,
  edited: {
    primaryColor: string
    position: string
    title: string
    locale: string
    greeting: string
    starters: string[]
  },
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    // Everything stored first, so a key this panel does not know about survives the save.
    ...stored,
    primaryColor: edited.primaryColor,
    position: edited.position,
    title: edited.title,
    locale: edited.locale,
    greeting: edited.greeting,
    starters: edited.starters,
  }
  // Absent, not empty. Absent is what makes the widget offer the business's approved canned
  // answers instead; an empty list would mean "offer nothing".
  if (edited.starters.length === 0) delete merged.starters
  return merged
}
