const test = require("node:test");
const assert = require("node:assert/strict");

const { ONBOARDING_QUESTIONS, buildOnboardingPreferences } = require("../src/core/profile/onboarding");

const VOTER = "0xF6e7501dFe7003299108020c5830C4c5B3CA6aA9";

test("ships a short fixed high-signal questionnaire", () => {
  assert.equal(ONBOARDING_QUESTIONS.length, 8);
  assert.equal(new Set(ONBOARDING_QUESTIONS.map((question) => question.id)).size, 8);
});

test("turns answered questions into timestamped stated preferences with provenance", () => {
  const result = buildOnboardingPreferences(VOTER, [
    { questionId: "public-goods", answer: "FOR", qualification: "when milestones are measurable" },
    { questionId: "experimentation", answer: "DEPENDS" },
    { questionId: "marketing-events", answer: "SKIP" },
  ], { recordedAt: "2026-09-01T12:00:00.000Z" });
  assert.equal(result.preferences.length, 2);
  assert.equal(result.preferences[0].recommendation, "FOR");
  assert.equal(result.preferences[0].provenance.source, "ONBOARDING_QUESTIONNAIRE");
  assert.equal(result.preferences[1].recommendation, undefined);
  assert.equal(result.preferences[1].provenance.answer, "DEPENDS");
});

test("rejects unknown and duplicate answers", () => {
  assert.throws(() => buildOnboardingPreferences(VOTER, [{ questionId: "unknown", answer: "FOR" }]), /Unknown/);
  assert.throws(() => buildOnboardingPreferences(VOTER, [
    { questionId: "public-goods", answer: "FOR" },
    { questionId: "public-goods", answer: "AGAINST" },
  ]), /Duplicate/);
});
