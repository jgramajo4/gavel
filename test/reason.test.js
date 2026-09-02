"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ProfileCategory } = require("../src/core/schema/profile");
const { CATEGORY_PHRASES, mainCategory } = require("../src/core/predict/reason");

test("uses the specific brand category instead of incidental development wording", () => {
  const categories = [
    ProfileCategory.PROTOCOL_DEVELOPMENT,
    ProfileCategory.MARKETING,
    ProfileCategory.EXPERIMENTAL,
  ];

  assert.equal(mainCategory(categories), ProfileCategory.MARKETING);
  assert.equal(CATEGORY_PHRASES[mainCategory(categories)], "brand and marketing initiatives");
});
