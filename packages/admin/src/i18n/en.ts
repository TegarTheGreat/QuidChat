/**
 * Every word this panel says, in English.
 *
 * This file is the source of truth, and `id.ts` is typed as `Dict` — so a missing translation, a
 * renamed key, or a parameter that changed shape is a compile error rather than a screen that
 * silently falls back to English in front of someone who does not read it. That is the whole
 * reason for the shape: a dictionary looked up by string key would happily return undefined.
 *
 * Values are functions wherever something is interpolated, because a translation is rarely the
 * same sentence with a word swapped — Indonesian puts the possessive after the noun, and a
 * template assembled from fragments produces text no native speaker would write.
 *
 * Code stays English: identifiers, comments, log lines, the API's own error strings. This is the
 * interface, and the businesses using it are Indonesian.
 */
export const en = {
  common: {
    save: "Save",
    saving: "Saving…",
    saved: "Saved.",
    cancel: "Cancel",
    delete: "Delete",
    edit: "Edit",
    add: "Add",
    close: "Close",
    refresh: "Refresh",
    loading: "Loading…",
    optional: "optional",
    nothing: "nothing",
    on: "on",
    off: "off",
    actionsFor: (name: string) => `Actions for ${name}`,
  },

  language: {
    label: "Language",
    english: "English",
    indonesian: "Bahasa Indonesia",
    /** Names the panel's own language, not the assistant's — those are different settings. */
    hint: "Changes this panel only. What your customers read is set per tenant, under Settings.",
  },

  nav: {
    brand: "QuidChat Admin",
    setup: "Setup",
    overview: "Overview",
    knowledge: "Knowledge",
    conversations: "Conversations",
    skills: "Skills & routing",
    canned: "Canned answers",
    channels: "Channels",
    escalations: "Escalations",
    tenants: "Tenants",
    settings: "Settings",
    signOut: "Sign out",
    switchTenant: "Switch tenant",
  },

  app: {
    noTenants: "No tenants yet. Create one from the Tenants section.",
  },

  token: {
    brand: "QuidChat Admin",
    title: "Admin token",
    description:
      "This panel needs the token this server was started with — QUIDCHAT_ADMIN_TOKEN in its environment.",
    label: "Token",
    submit: "Open the panel",
    selectTenant: "Select a tenant",
    noTenantSelected: "No tenant selected",
    manageTenants: "Manage tenants",
    invalid: "That token was refused. Check QUIDCHAT_ADMIN_TOKEN on the server.",
  },

  setup: {
    title: "Setup",
    ready: "Ready to answer customers",
    readyDetail: "Nothing is blocking the assistant. Anything below is optional polish.",
    notReady: "Not answering yet",
    notReadyDetail: "Something below has to be fixed before a customer can get an answer.",
    allClear: "Nothing to report — this tenant is fully configured.",
    severity: { blocker: "Blocking", warning: "Warning", suggestion: "Suggestion" },
    whatToDo: "What to do: ",
    openSettings: "Open settings",
    addDocument: "Add a document",
    seeSources: "See your sources",
    seeFailures: "See what failed",
    writeAnswer: "Write an answer",
    readQuestions: "Read the questions",
    assistant: {
      title: "Ask about your setup",
      description:
        "It checks the real thing before answering — what is indexed, what is configured, what the diagnostics say — rather than answering from memory.",
      placeholder: "Ask about anything on this page",
      inputLabel: "Ask the setup assistant",
      ask: "Ask",
      checking: "Checking…",
      checked: (tools: string) => `Checked: ${tools}`,
      doIt: "Do it",
      leaveIt: "Leave it",
      openers: [
        "Why is my assistant refusing questions?",
        "What does answer mode change?",
        "Is anything blocking it from answering?",
      ] as readonly string[],
    },
  },

  overview: {
    title: "Overview",
    questions: "Questions this month",
    questionsHint: "From your website and every channel you have connected.",
    answered: "Answered from your documents",
    answeredNone: "No questions yet this month.",
    answeredDetail: (answered: number, refused: number) =>
      `${answered} answered, ${refused} declined rather than guessed at.`,
    waiting: "Waiting for an answer",
    waitingNone: "Nothing outstanding.",
    waitingSome: "Each one is a customer question your documents did not cover.",
    answerThem: "Answer them",
    spent: "Spent this month",
    budgetLoading: "Loading your budget…",
    budgetNone: "No monthly limit set. Set one in Settings before this runs on a live site.",
    budgetLeft: (left: string, total: string) =>
      `${left} left of ${total}. The assistant stops answering when it runs out.`,
    budgetBarLabel: "Share of this month's budget spent",
  },

  knowledge: {
    title: "Knowledge",
    addSource: "Add source",
    columnTitle: "Title",
    columnWhere: "Where from",
    columnStatus: "Status",
    empty:
      "Nothing indexed yet. Until something is, every question is refused — which is the assistant working, not failing.",
    fromUrl: "page",
    fromFile: "uploaded file",
    fromText: "pasted text",
    noReason: "No reason was recorded.",
    reindex: "Re-read this page",
    reindexed: (title: string, chunks: number) =>
      `Re-read “${title}” — ${chunks} pieces indexed.`,
    reindexFailed: (title: string, reason: string) =>
      `Could not re-read “${title}”: ${reason}. The old text is still in use.`,
    unknownReason: "unknown reason",
    deleteTitle: (title: string) => `Delete “${title}”?`,
    deleteDescription:
      "Its text and everything indexed from it goes with it, and the assistant stops answering from it immediately. Past answers stay in the transcript but no longer link to it. The source has to be added again.",
    deleteConfirm: "Delete it",
    dialog: {
      title: "Add a source",
      description: "The assistant answers only from what is here, and cites it.",
      tabText: "Paste text",
      tabUrl: "A page",
      tabSite: "A whole site",
      tabPdf: "A PDF",
      titleLabel: "Title",
      titleHint: "Customers see this name under any answer that came from it.",
      textLabel: "Text",
      indexText: "Index this text",
      urlLabel: "Address",
      urlTitleLabel: "Title (optional)",
      urlTitlePlaceholder: "taken from the page when left empty",
      readPage: "Read the page",
      siteLabel: "Address to start from",
      siteHint:
        "Links are followed from this page, nearest first, and robots.txt is respected. A sitemap address works too, and is read exactly as written.",
      sitePagesLabel: "How many pages at most",
      sitePagesHint:
        "Up to 25. Every page is fetched and indexed before this dialog closes, so a large site is better done in a few passes.",
      readSite: "Read this site",
      readingSite: "Reading the site…",
      pdfLabel: "File",
      pdfHint:
        "Up to about 9 MB. A scanned PDF is refused with the reason — it draws its letters as pictures, so it has to go through OCR before anything can read it.",
      uploadPdf: "Upload and index",
      readingPdf: "Reading…",
    },
    crawling: "Reading the site. This takes a moment — one page at a time.",
    crawled: (pages: number) => `Indexed ${pages} page${pages === 1 ? "" : "s"}.`,
    crawledWithFailures: (pages: number, failed: number, urls: string) =>
      `Indexed ${pages} page${pages === 1 ? "" : "s"}. ${failed} could not be read: ${urls}`,
  },

  conversations: {
    title: "Conversations",
    description:
      "What your customers asked and what the assistant said back, with the document behind every claim it made about your business.",
    empty: "No conversations yet. They appear here as soon as someone asks the widget something.",
    select: "Select a conversation.",
    noMessages: "This conversation has no messages recorded.",
    back: "All conversations",
    messages: (count: number) => `${count} message${count === 1 ? "" : "s"}`,
    unknownVisitor: "an unknown visitor",
    rowActions: (visitor: string) => `Actions for the conversation with ${visitor}`,
    deleteTranscript: "Delete transcript",
    deleteTitle: (visitor: string) => `Delete the transcript with ${visitor}?`,
    deleteThisVisitor: "this visitor",
    deleteDescription:
      "Every message in it goes, along with what the assistant cited and any escalation raised from it. This is what to use when a customer asks you to erase what you hold about them. What stays is this month's total spend, which carries no message text.",
    deleteConfirm: "Delete it",
    writeAnswer: "Write the answer for this",
    saveDialog: {
      title: "Write the answer for this question",
      description:
        "A canned answer is used word for word, ahead of anything the assistant would compose. Use it where the wording has to be exact.",
      question: "Question",
      answer: "Answer",
      answerHint: "This is what the assistant said. Correct it — that is usually why you are here.",
      draft: "Save as draft",
      publish: "Save and use it",
    },
    savedApproved: "Saved. That question is answered from your own words from now on.",
    savedDraft:
      "Saved as a draft. It starts being used once you approve it on the Canned answers screen.",
  },

  skills: {
    title: "Skills & routing",
    addSkill: "Add skill",
    graphTitle: "How an incoming message is routed",
    noSkills:
      "No skills yet. Without any, every question is answered from all of this tenant's documents — which is a sensible default, not a problem.",
    columnName: "Name",
    columnRouting: "Routes here when",
    columnSkill: "Skill",
    ruleWhen: "When",
    ruleWord: "Word",
    ruleWordPlaceholder: "garansi",
    ruleKeyword: "the message contains a word",
    ruleFallback: "nothing else matched",
    ruleOrderHint:
      "Rules run in order from the top and the first match wins, so this one is added at the end.",
    ruleDialogTitle: (skill: string) => `Send messages to ${skill}`,
    sourcesDialogTitle: (skill: string) => `Documents ${skill} may use`,
    promptFooter:
      "Added to the grounding rules, never in place of them — a skill sets voice and scope, not whether citations are required.",
    modeInheritShort: "same as the tenant",
    namePlaceholder: "Sales",
    columnRoutingShort: "Routing",
    linkedCount: (count: number) => `${count} linked`,
    addDescription: "A persona with its own instructions and its own slice of the documents.",
    editDescription:
      "Renaming changes only what you see here — the assistant's answers are unaffected.",
    deleteSkillDescription:
      "Its routing rules and document links go with it. Conversations it already answered stay in the transcript — deleting a persona should not rewrite what customers were told.",
    deleteSkillConfirm: "Delete skill",
    removeRuleTitle: "Remove this rule?",
    removeRuleDescription:
      "Messages it was catching fall through to the rules below it, and then to the fallback skill.",
    removeRuleConfirm: "Remove rule",
    promptLabelLong: "How it should answer",
    promptPlaceholder: "You handle questions about products and prices.",
    ruleKindLabel: "Rule kind",
    notBuiltHint: "Not built yet — a rule of this kind is skipped when messages are routed.",
    noneTickedHint: "With none ticked, this skill can answer from every document.",
    noDocuments: "No documents indexed yet.",
    columnDocuments: "Documents",
    columnMode: "Answer mode",
    fallbackBadge: "fallback",
    disabledBadge: "off",
    noRules: "nothing points here",
    allDocuments: "all of them",
    documentCount: (count: number) => `${count} chosen`,
    addRule: "Add routing rule",
    chooseDocuments: "Choose documents",
    makeFallback: "Make the fallback",
    disable: "Disable",
    enable: "Enable",
    deleteSkill: "Delete",
    removeRule: (pattern: string) => `Remove the rule for ${pattern}`,
    dialog: {
      addTitle: "Add a skill",
      editTitle: (name: string) => `Edit ${name}`,
      description:
        "A skill is a subject with its own instructions and its own documents — sales, delivery, warranty. Routing decides which one answers.",
      nameLabel: "Name",
      promptLabel: "Instructions",
      promptHint:
        "Sent with every question this skill answers. Say how to answer, not what is true — what is true comes from the documents.",
      modeLabel: "Answer mode",
      modeInherit: "Same as this tenant",
      fallbackLabel: "Answer anything no rule matched",
      enabledLabel: "In use",
    },
    ruleDialog: {
      title: (skill: string) => `Route to ${skill} when…`,
      description:
        "Rules are read from the top, and the first match wins. A keyword rule is exact and free; the others are not built yet.",
      kindLabel: "Kind",
      patternLabel: "Keyword",
      patternHint: "Matched anywhere in the customer's message, ignoring case.",
      submit: "Add rule",
    },
    sourcesDialog: {
      title: (skill: string) => `Documents ${skill} may answer from`,
      description:
        "Nothing chosen means every document this tenant has. Choose some to narrow it — a warranty skill answering from the price list is how a wrong answer gets a citation attached.",
      empty: "This tenant has no documents yet.",
    },
    deleteTitle: (name: string) => `Delete ${name}?`,
    deleteDescription:
      "Its routing rules go with it, and any question they used to catch is answered from all of this tenant's documents instead. The documents themselves stay.",
    deleteConfirm: "Delete it",
    ruleKinds: { keyword: "keyword", semantic: "semantic", llm: "llm", fallback: "fallback" },
  },

  routing: {
    everythingElse: "Everything else",
    contains: (pattern: string) => `Contains “${pattern}”`,
    noKeyword: "No keyword set",
    similar: "Similar in meaning",
    modelDecides: "Decided by the model",
    empty: "No rules yet. Every message is answered directly, without choosing a skill.",
    off: "off",
    notBuilt: "not built yet",
    neverReached: "never reached",
    fallback: "fallback",
    sources: (count: number) => `${count} source${count === 1 ? "" : "s"}`,
    handoffOnly: (names: string) =>
      `No rule leads to ${names}. These are reachable only when another skill hands a question over.`,
    footnote:
      "Rules run top to bottom, and the first match wins. Beyond that, the skill answering can hand a question to another one when it turns out not to be its subject.",
  },

  canned: {
    title: "Canned answers",
    lead: "Exact answers to exact questions, matched without calling a model. In static mode these are the only thing the assistant can say, so it costs nothing to run.",
    count: (total: number) => `${total} answer${total === 1 ? "" : "s"}`,
    waitingApproval: (count: number) => `${count} waiting for approval`,
    emptyStatic:
      "Nothing yet. A tenant in static mode with no approved answers refuses every question — deliberately, since the alternative is inventing one.",
    columnActions: "Actions",
    draftBadge: "Draft — not sent",
    questionLabel: "Question a customer would ask",
    questionPlaceholder: "How long is the warranty?",
    answerLabel: "Answer to send, word for word",
    answerPlaceholder: "Every unit carries a one-year warranty from the purchase date.",
    addDescription:
      "Matching tolerates different wording and typos, so write the question the way a customer would — not as a keyword.",
    editDescription:
      "Saving sends it back to draft — the approval was for the old words, and a person should read the new ones before a customer does.",
    deleteAnswer: "Delete answer",
    addAnswer: "Add answer",
    columnQuestion: "Question",
    columnAnswer: "Answer",
    columnStatus: "Status",
    empty: "Nothing written yet.",
    live: "Live",
    draft: "Draft",
    approve: "Approve",
    withdraw: "Withdraw",
    deleteTitle: (question: string) => `Delete “${question}”?`,
    deleteDescription:
      "The assistant goes back to composing an answer for this question from your documents, or refusing if they do not cover it.",
    deleteConfirm: "Delete it",
    dialog: {
      addTitle: "Add an answer",
      editTitle: "Edit this answer",
      description:
        "Matched against questions that mean the same thing, not only the exact words. Edited answers go back to draft, because the approval was for words that no longer exist.",
      questionLabel: "Question",
      answerLabel: "Answer",
      addAndApprove: "Add and approve",
      addAsDraft: "Add as draft",
      saveChanges: "Save changes",
    },
  },

  channels: {
    title: "Channels",
    description:
      "The same assistant, answering where your customers already are. Every channel goes through the identical pipeline, so grounding, refusals and your budget behave exactly as they do on your website.",
    noKeyTitle: "Credentials cannot be stored yet",
    noKeyBody: (generate: string) =>
      `Set QUIDCHAT_SECRET_KEY on the server and restart it. Channel credentials are encrypted with it, and storing them in plain text is not offered as an alternative — a database backup would hand over the ability to send messages as your business. Generate one with ${generate}.`,
    columnChannel: "Channel",
    columnStatus: "Status",
    columnStored: "Stored",
    connected: "Connected",
    paused: "Paused",
    notConnected: "Not connected",
    connect: "Connect",
    replace: "Replace credentials",
    pause: "Pause",
    resume: "Resume",
    disconnect: "Disconnect",
    disconnectTitle: (name: string) => `Disconnect ${name}?`,
    disconnectDescription:
      "Its stored credentials are deleted, and messages arriving on it stop being answered. To connect it again you need the token from the platform a second time — to stop answering for a while without that, pause it instead.",
    disconnectConfirm: "Disconnect it",
    dialogConnect: (name: string) => `Connect ${name}`,
    dialogReplace: (name: string) => `Replace ${name} credentials`,
    pointAt: (name: string) => `Point ${name} at this address`,
    copyAddress: "Copy the webhook address",
    stored: "stored — type to replace",
    secretHint:
      "Set the webhook secret too, where the platform offers one. Without it, anyone who learns the address above can put words in your conversation history and spend your budget.",
  },

  escalations: {
    title: "Escalations",
    description:
      "Questions your assistant declined rather than guessed at. Answering one here saves it as a canned answer, so the next customer who asks gets a reply.",
    empty:
      "Nothing declined yet. On a live assistant this list filling up is not a fault — it is the assistant refusing to invent answers, and it is where the next thing to write down comes from.",
    columnQuestion: "What the customer asked",
    columnWhen: "When",
    columnState: "State",
    columnAnswer: "Answer it",
    handled: "Handled",
    open: "Open",
    noQuestion: "No question was recorded",
    writeAnswer: "Write an answer",
    dismiss: "Dismiss",
    reopen: "Reopen",
    reasons: {
      no_source: "Nothing in your documents covered it",
      ungrounded: "The answer could not be backed by a source",
      budget_exhausted: "The monthly budget was already spent",
      provider_unavailable: "The AI provider could not be reached",
      handoff_limit: "Passed between skills too many times",
      rate_limited: "Too many messages too quickly",
    } as Record<string, string>,
    dialog: {
      title: "Answer this question",
      description:
        "Saved as an approved canned answer and matched against future questions, including differently worded ones. It is sent word for word, so write it as you would want a customer to read it.",
      question: "The question",
      answer: "Your answer",
      answerPlaceholder:
        "Yes — we deliver across Java, and delivery to Bali takes three days.",
      submit: "Save and publish",
    },
    savedNotResolved: (reason: string) =>
      `The answer was saved, but this row could not be marked handled: ${reason}`,
  },

  tenants: {
    title: "Tenants",
    addTenant: "Add tenant",
    columnName: "Name",
    columnSlug: "Slug",
    empty: "No businesses yet. Add one to get an embed snippet and a place to put knowledge.",
    openBadge: "Open",
    workOnThis: "Work on this one",
    rename: "Rename",
    delete: "Delete",
    createTitle: "Add a tenant",
    createDescription:
      "One business, with its own knowledge, its own channels and its own key. Nothing is shared between tenants.",
    nameLabel: "Name",
    slugLabel: "Slug",
    slugHint: "Goes in the embed snippet, so pick it once — it cannot be changed later.",
    originsLabel: "Allowed origins",
    originsHint: "The sites allowed to open this widget. Leave it empty while testing locally.",
    createSubmit: "Add this tenant",
    creating: "Adding…",
    renameTitle: (name: string) => `Rename “${name}”`,
    renameDescription: (slug: string) =>
      `Only what you see in the panel. Customers see the widget's own title, and the slug in the embed snippet stays ${slug}.`,
    renameSubmit: "Save name",
    deleteTitle: (name: string) => `Delete “${name}”?`,
    deleteDescription:
      "Its knowledge, conversations, transcripts, channel connections and saved provider key go with it, and the widget on its website stops answering. There is no undo, and no backup is taken first.",
    deleteConfirmLabel: (slug: string) => `Type ${slug} to confirm`,
    deleteSubmit: "Delete this tenant",
    deleting: "Deleting…",
  },

  settings: {
    title: "Settings",
    selectTenant: "Select a tenant first to edit its settings.",
    originsPlaceholder: "https://example.com",
    widgetDisabledTitle: "Widget disabled",
    widgetDisabledBody:
      "No allowed origins are configured, so the widget will refuse every site. Add at least one origin to enable it.",
    modelsUnavailable: "Add a provider key above and the models it offers will appear here.",
    save: "Save changes",
    tabs: { models: "Models", answering: "Answering", limits: "Limits", widget: "Widget" },
    form: {
      chatModel: "Chat model",
      rewriteModel: "Rewrite model",
      embeddingModel: "Embedding model",
      answerMode: "Answer mode",
      answerModeFull: "full — generate an answer from your documents",
      answerModeThrifty: "thrifty — quote your documents, no generation",
      answerModeStatic: "static — approved canned answers only, no model",
      answerModeHint:
        "The one setting that changes what running this costs. static never calls a model, so it is free to run and can only say what someone approved.",
      refusalText: "Refusal text",
      escalationMode: "When it cannot answer",
      escalationCollect: "record it here — read them under Escalations",
      escalationWebhook: "post it to a webhook — Slack, Discord, n8n, your CRM",
      webhookUrl: "Webhook URL",
      webhookHint:
        "Sent as JSON with the customer's question, the reason, and the channel — the question is the part that tells you what to write. Only used when the mode above is set to webhook.",
      highRisk: "High-risk topics",
      highRiskPlaceholder: "e.g. medical advice",
      budget: "Monthly budget (cents)",
      retention: "Retention (days)",
      handoffsTurn: "Max handoffs per turn",
      handoffsConversation: "Max handoffs per conversation",
      allowedOrigins: "Allowed origins",
      accent: "Accent colour",
      side: "Which side it sits on",
      sideRight: "bottom right",
      sideLeft: "bottom left",
      widgetLanguage: "Language of the buttons and placeholder",
      greeting: "First thing a customer reads",
      greetingPlaceholder: "Halo! Ada yang bisa kami bantu?",
      starters: "Questions offered before they type",
      startersPlaceholder: "e.g. Berapa lama garansinya?",
      widgetTitle: "Title your customers see",
      widgetTitlePlaceholder: "Chat assistant",
    },
    provider: {
      title: "AI provider",
      usingServer: "Using whatever this server was started with. Add a key below to bill your own account.",
      usingOwn: "Answering with your own key:",
      noSecretKey:
        "This deployment has no QUIDCHAT_SECRET_KEY, so credentials cannot be stored safely yet. Generate one with openssl rand -base64 32 and restart.",
      providerLabel: "Provider",
      keyLabel: "API key",
      addressLabel: "Address",
      use: (name: string) => `Use ${name}`,
      useServer: "Use this server's provider instead",
      remove: (name: string) => `Remove the ${name} key`,
      stored: "stored — type to replace",
      localRunner: (models: string, more: boolean) =>
        `A model runner is already going on this server, with ${models}${more ? " and others" : ""}. Nothing leaves your machine and it costs nothing to run.`,
      useLocalRunner: "Use it",
      where: {
        OPENAI_API_KEY: "platform.openai.com → API keys",
        GROQ_API_KEY: "console.groq.com → API keys. Has a free tier, and is the fastest of these.",
        GEMINI_API_KEY: "aistudio.google.com → Get API key. Has a free tier.",
        ANTHROPIC_API_KEY: "console.anthropic.com → API keys",
        OPENROUTER_API_KEY: "openrouter.ai → Keys. One key reaches models from every vendor above.",
        OLLAMA_BASE_URL:
          "No key and no account. Nothing leaves your server, and it costs nothing to run.",
      } as Record<string, string>,
    },
    model: {
      loading: "Asking your provider what it has…",
      failed: "Could not list models — type the name instead.",
      typeInstead: "Type a name instead",
      chooseInstead: "Choose from the list",
      empty: "Your provider returned no models.",
    },
    fields: {
      chatModel: "Model for answers",
      rewriteModel: "Model for rewriting questions",
      embeddingModel: "Model for search",
      answerMode: "Answer mode",
      answerModeStatic: "Only approved answers",
      answerModeThrifty: "Search the documents",
      answerModeFull: "Search, after rewriting the question",
      refusalText: "What it says when it does not know",
      escalationMode: "When it gives up",
      escalationTarget: "Where to notify",
      monthlyBudget: "Monthly budget (US dollars)",
      retentionDays: "Keep conversations for (days)",
      highRiskTopics: "Never guess about",
      allowedOrigins: "Allowed origins",
      maxHandoffsTurn: "Handoffs per question",
      maxHandoffsConversation: "Handoffs per conversation",
      widgetColor: "Accent colour",
      widgetPosition: "Side of the screen",
      widgetPositionLeft: "Left",
      widgetPositionRight: "Right",
      widgetTitle: "Title in the widget header",
      widgetLocale: "Language your customers see",
      widgetGreeting: "First thing a customer reads",
      widgetStarters: "Questions offered to start with",
    },
  },
}

export type Dict = typeof en
