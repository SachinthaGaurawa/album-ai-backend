// ==========================================================
// /api/skills.js  — skill/feature registry (CommonJS)
// Each skill adds targeted instructions on top of RAG context.
// ==========================================================

const normalize = (s) => (s || "").toLowerCase();

function pat(re) { return (q) => re.test(normalize(q)); }

function template(id, matchFn, instructions) {
  return { id, match: matchFn, build: ({ question, ctx, topic, owner }) =>
    [
      "KB:",
      '"""', ctx || "NO CONTEXT", '"""', "",
      `User question: ${question}`, "",
      "Skill:", id,
      "Do the following precisely:",
      instructions,
      "",
      "Rules:",
      "- Use only facts from KB above; if unknown, say it's unspecified.",
      "- Be concise. Use bullets where helpful. Add 1–3 friendly emojis if suitable.",
    ].join("\n")
  };
}

// Some helper follow-ups by topic
const SKILL_META = {
  followups(topic) {
    if (topic === "aavss") return [
      "Do you want calibration steps?",
      "Show safety alert thresholds?",
      "List recommended hardware profiles?",
      "Need an integration checklist?"
    ];
    if (topic === "sldataset") return [
      "Do you want dataset splits?",
      "Show annotation schema examples?",
      "Summarize licensing and allowed use?",
      "Suggest evaluation metrics?"
    ];
    return [
      "Switch to AAVSS details?",
      "Switch to Dataset details?",
      "Generate an image (/gen …)?"
    ];
  }
};

// ---------- Command detection for /gen and /browse ----------
function detectCommand(qRaw) {
  const q = qRaw.trim();
  const gen = q.match(/^\/?gen(?:erate)?\s+(.+)/i);
  if (gen) return { kind: "gen", prompt: gen[1].trim(), n: 2, aspect: "16:9", realism: "photo" };
  const br = q.match(/^\/?browse\s+(.+)/i);
  if (br)  return { kind: "browse", query: br[1].trim(), n: 12 };
  return null;
}

// ---------- Core skills (high-impact) ----------
const SKILLS = [
  template("summarize", pat(/\b(summariz(e|e it)|tl;dr|brief|short version)\b/), "Provide a crisp summary in 3–6 bullet points."),
  template("eli5", pat(/\b(eli5|explain like i'?m 5|simple terms|explain simply)\b/), "Explain like I'm 5 years old using simple language and a relatable analogy."),
  template("checklist", pat(/\b(check ?list|steps|todo|action items)\b/), "Create a step-by-step checklist with 5–12 items."),
  template("calibration", pat(/\b(calibration|calibrate|extrinsic|intrinsic|sync|time[- ]sync)\b/), "Outline calibration steps for sensors in AAVSS (generic unless KB specifies)."),
  template("risk-safety", pat(/\b(risk|safety|hazard|alert|warning|threshold)\b/), "Provide a brief risk matrix (Low/Med/High) and suggested alert thresholds if known."),
  template("pros-cons", pat(/\b(pros? and cons?|advantages?|disadvantages?)\b/), "List pros and cons in separate bullet lists."),
  template("compare", pat(/\b(compare|vs\.?|versus|difference|which is better)\b/), "Provide a concise comparison table in Markdown."),
  template("table", pat(/\b(make|show|format).*(table|tabular)\b/), "Return a compact Markdown table capturing the key facts only."),
  template("json-extract", pat(/\b(json|structured|schema|key[: ]?value)\b/), "Return a small JSON object with the essential fields derived from KB."),
  template("glossary", pat(/\b(glossary|define|definitions?)\b/), "Make a mini-glossary of important terms and one-line definitions."),
  template("metrics", pat(/\b(metric|kpi|evaluate|bench(mark|marking))\b/), "Propose evaluation metrics and short rationales (if KB doesn't specify, mark as 'suggested')."),
  template("roadmap", pat(/\b(road ?map|timeline|milestones?)\b/), "Draft a 30–90 day roadmap with weekly milestones."),
  template("faq", pat(/\b(faq|questions and answers|common questions?)\b/), "Produce a short FAQ (5–8 Q&A pairs) using only KB facts."),
  template("quiz", pat(/\b(quiz|test me|questions for me)\b/), "Create 5 multiple-choice questions with answers at the end."),
  template("flashcards", pat(/\b(flash ?cards?|study cards?)\b/), "Generate 8 Q→A flashcards in Markdown."),
  template("translate", pat(/\b(translate|in (sinhala|tamil|english|spanish|german|french))\b/), "Translate the key KB facts related to the question into the requested language."),
  template("rewrite-tone", pat(/\b(rewrite|rephrase|tone|friendlier|more formal|shorter|longer)\b/), "Rewrite the content with the requested tone and length while preserving facts."),
  template("owner", pat(/\b(who is sachintha|owner|concept|manufacturer)\b/), "Answer clearly using the 'about' KB entries and include the owner’s name."),
  template("dataset-license", pat(/\b(license|licence|allowed|usage|terms)\b/), "Summarize dataset license/usage if present; otherwise state it's unspecified and invite a PDF."),
  template("annotation-schema", pat(/\b(annotat(e|ions?)|labels?|classes?)\b/), "Outline annotation types found in KB. If not in KB, say unspecified and suggest adding."),
  template("image-brief", pat(/\b(image|visual|illustration|diagram)\b/), "Produce a concise creative brief the UI could send to /api/img."),
  // Utilities
  {
    id: "math-units",
    match: (q) => /^=|convert\b|unit\b/.test(normalize(q)),
    build: ({ question, ctx }) => {
      const expr = question.replace(/^=/, "").trim();
      return [
        "You are a precise calculator and unit converter.",
        '"""', ctx || "", '"""', "",
        `Expression or conversion request: ${expr}`,
        "Return the numeric result and a one-line explanation. If out of scope, say so."
      ].join("\n");
    }
  },
];

// Try matching first applicable skill
function matchSkill(question) {
  for (const s of SKILLS) {
    try { if (s.match(question)) return s; } catch {}
  }
  return null;
}

function buildSkillPrompt({ question, ctx, topic, owner, skill }) {
  return skill.build({ question, ctx, topic, owner });
}

module.exports = { matchSkill, buildSkillPrompt, detectCommand, SKILL_META };
