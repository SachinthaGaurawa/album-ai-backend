// ==========================================================
// /api/skills.js  — skill/feature registry (CommonJS)
// Each skill adds targeted instructions on top of RAG context.
// ==========================================================

// /api/skills.js — Skill/feature registry for specialized instructions
const normalize = (s) => (s || "").toLowerCase();
function pat(re) { return (q) => re.test(normalize(q)); }

function template(id, matchFn, instructions) {
  return { 
    id, 
    match: matchFn, 
    build: ({ question, ctx, topic, owner }) =>
      [
        "KB:",
        '"""', ctx || "NO CONTEXT", '"""', "",
        `User question: ${question}`, "",
        `Skill: ${id}`,
        "Do the following precisely:",
        instructions,
        "",
        "Rules:",
        "- Use only facts from KB above; if something is unknown, say it's unspecified or not in the context.",
        "- Be concise. Use bullet points or tables if it improves clarity. Add 1–3 friendly emojis if it suits the answer.",
      ].join("\n")
  };
}

// Primary skills triggered by certain keywords in the question
const SKILLS = [
  template("summarize", pat(/\b(summarize|summarise|brief|short version|tl;dr)\b/),
           "Provide a crisp summary in 3–6 bullet points."),
  template("eli5", pat(/\b(eli5|explain like i'?m 5|simple terms|explain (it )?simply)\b/),
           "Explain it as if I'm 5 years old, using simple language and a relatable analogy."),
  template("checklist", pat(/\b(check ?list|steps|todo|action items)\b/),
           "Create a step-by-step checklist with 5–12 items to accomplish this."),
  template("calibration", pat(/\b(calibration|calibrate|extrinsic|intrinsic|time ?sync|synchronization)\b/),
           "Outline the calibration steps for sensors in AAVSS (generic steps if not specified in context)."),
  template("risk-safety", pat(/\b(risk|safety|hazard|alert|warning|threshold)\b/),
           "Provide a brief risk assessment (Low/Med/High) and any suggested alert thresholds mentioned in the context."),
  template("pros-cons", pat(/\b(pros and cons|pros\/cons|advantages|disadvantages)\b/),
           "List the pros and cons in separate bullet lists."),
  template("compare", pat(/\b(compare|vs\.|versus|difference|which is better)\b/),
           "Provide a concise comparison in a Markdown table with key points."),
  template("table", pat(/\b(make|show|format).*(table|tabular)\b/),
           "Return a compact Markdown table capturing the key facts from context."),
  template("json-extract", pat(/\b(json|structured|schema|key[: ]?value)\b/),
           "Return a JSON object with essential fields extracted from the context."),
  template("glossary", pat(/\b(glossary|define|definitions?)\b/),
           "List important terms from the context with one-line definitions for each."),
  template("metrics", pat(/\b(metric|kpi|evaluate|benchmark)\b/),
           "Suggest relevant evaluation metrics and short explanations (mark as 'suggested' if not in context)."),
  template("roadmap", pat(/\b(road ?map|timeline|milestone)\b/),
           "Draft a timeline or roadmap with key milestones (e.g., over the next 3 months)."),
  template("faq", pat(/\b(faq|questions and answers|common questions?)\b/),
           "Produce a short FAQ with 5–8 Q&A pairs using details from context."),
  template("quiz", pat(/\b(quiz|test me|practice questions?)\b/),
           "Create 5 multiple-choice questions (with answers) based on the content."),
  template("flashcards", pat(/\b(flash ?cards?|study cards?)\b/),
           "Generate 5 Q&A flashcards (question on one side, answer on the other) in Markdown format."),
  template("translate", pat(/\b(translate|in (sinhala|tamil|english|spanish|german|french))\b/),
           "Translate the key facts from the context into the requested language."),
  template("rewrite-tone", pat(/\b(rewrite|rephrase|tone|friendlier|more formal|shorter|longer)\b/),
           "Rewrite the content with the requested tone and length while preserving all facts."),
  template("owner", pat(/\b(owner|who (made|built)|who is (sachintha|the creator))\b/),
           "Answer using any 'about' info in context, including the project owner’s name and role."),
  template("dataset-license", pat(/\b(license|usage terms|allowed|permission)\b/),
           "Summarize the dataset license/usage terms from context. If not specified, say it's unspecified."),
  template("annotation-schema", pat(/\b(annotation|labels|classes|taxonomy)\b/),
           "Describe the annotation schema or label types from context (or state it's not detailed)."),
  template("image-brief", pat(/\b(image|visual|illustration|diagram)\b/),
           "Provide a concise creative brief (1-3 sentences) for an image related to this topic that could be generated.")
  // Additional skills can be added here...
];

// Utility to detect slash commands quickly
function detectCommand(qRaw) {
  const q = qRaw.trim();
  const genMatch = q.match(/^\/?gen(?:erate)?\s+(.+)/i);
  if (genMatch) {
    return { kind: "gen", prompt: genMatch[1].trim(), n: 2, aspect: "16:9", realism: "photo" };
  }
  const brMatch = q.match(/^\/?browse\s+(.+)/i);
  if (brMatch) {
    return { kind: "browse", query: brMatch[1].trim(), n: 12 };
  }
  return null;
}

// Follow-up suggestions for specific topics or generic
const SKILL_META = {
  followups(topic) {
    if (topic === "aavss") {
      return [
        "Do you want calibration steps?",
        "Show safety alert thresholds?",
        "List recommended hardware profiles?",
        "Need an integration checklist?"
      ];
    }
    if (topic === "sldataset") {
      return [
        "Do you want dataset splits?",
        "Show annotation schema examples?",
        "Summarize licensing and allowed use?",
        "Suggest evaluation metrics?"
      ];
    }
    // Generic suggestions if topic is not explicitly recognized
    return [
      "Switch to AAVSS details?",
      "Switch to Dataset details?",
      "Generate an image (/gen ...)?"
    ];
  }
};

function matchSkill(question) {
  for (const s of SKILLS) {
    try {
      if (s.match(question)) return s;
    } catch { /* ignore errors */ }
  }
  return null;
}

function buildSkillPrompt({ question, ctx, topic, owner, skill }) {
  return skill.build({ question, ctx, topic, owner });
}

module.exports = { matchSkill, buildSkillPrompt, detectCommand, SKILL_META };
