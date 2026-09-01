const { getAddress } = require("ethers");
const { z } = require("zod");

const { ProfileCategory, statedPreferenceSchema } = require("../schema/profile");

const ONBOARDING_QUESTIONS = Object.freeze([
  { id: "treasury-spending", prompt: "Default stance on material treasury spending?", categories: [ProfileCategory.TREASURY] },
  { id: "public-goods", prompt: "Default stance on measurable public-goods funding?", categories: [ProfileCategory.PUBLIC_GOODS] },
  { id: "recurring-expenses", prompt: "Default stance on recurring operating expenses?", categories: [ProfileCategory.RECURRING_FUNDING] },
  { id: "experimentation", prompt: "Default stance on pilots and unproven experiments?", categories: [ProfileCategory.EXPERIMENTAL] },
  { id: "governance-changes", prompt: "Default stance on governance-process changes?", categories: [ProfileCategory.GOVERNANCE_UPGRADE] },
  { id: "protocol-investment", prompt: "Default stance on direct protocol development?", categories: [ProfileCategory.PROTOCOL_DEVELOPMENT] },
  { id: "marketing-events", prompt: "Default stance on marketing and events?", categories: [ProfileCategory.MARKETING, ProfileCategory.EVENTS] },
  { id: "uncertainty", prompt: "Default vote when evidence is insufficient?", categories: [] },
]);

const answerSchema = z.object({
  questionId: z.string(),
  answer: z.enum(["FOR", "AGAINST", "ABSTAIN", "DEPENDS", "SKIP"]),
  qualification: z.string().trim().min(1).max(1000).optional(),
});

function buildOnboardingPreferences(voterInput, answersInput, options = {}) {
  const voter = getAddress(voterInput);
  const recordedAt = new Date(options.recordedAt || new Date()).toISOString();
  const byId = new Map(ONBOARDING_QUESTIONS.map((question) => [question.id, question]));
  const answers = z.array(answerSchema).max(ONBOARDING_QUESTIONS.length).parse(answersInput);
  const seen = new Set();
  const preferences = [];
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) throw new Error(`Unknown onboarding question: ${answer.questionId}`);
    if (seen.has(answer.questionId)) throw new Error(`Duplicate onboarding answer: ${answer.questionId}`);
    seen.add(answer.questionId);
    if (answer.answer === "SKIP") continue;
    const qualification = answer.qualification;
    const statement = qualification
      ? `${question.prompt} Answer: ${answer.answer}. Qualification: ${qualification}`
      : `${question.prompt} Answer: ${answer.answer}.`;
    preferences.push(statedPreferenceSchema.parse({
      id: `onboarding-${answer.questionId}-${recordedAt.replace(/\D/g, "")}`,
      statement,
      createdAt: recordedAt,
      active: true,
      categories: question.categories,
      recommendation: answer.answer === "DEPENDS" ? undefined : answer.answer,
      provenance: {
        source: "ONBOARDING_QUESTIONNAIRE",
        questionId: answer.questionId,
        answer: answer.answer,
        qualification,
      },
    }));
  }
  return { schemaVersion: "1.0.0", voter, recordedAt, preferences };
}

module.exports = { ONBOARDING_QUESTIONS, buildOnboardingPreferences };
