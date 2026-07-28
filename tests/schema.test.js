// schema.test.js — Validates that the migrated registry and every claim
// file conform to the Living Book v2 schema. Uses only node:test + node:assert.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  PATHS,
  readJSON,
  validateClaimFile,
  validateRegistryEntry,
} = require("../scripts/lib.js");

test("registry file exists and is valid JSON with a questions array", () => {
  assert.ok(fs.existsSync(PATHS.registry), "registry file should exist");
  const data = readJSON(PATHS.registry);
  assert.ok(data && Array.isArray(data.questions), "questions must be array");
  assert.ok(data.questions.length > 0, "registry must not be empty");
  assert.strictEqual(
    data.total_questions,
    data.questions.length,
    "total_questions must match questions.length"
  );
});

test("every registry entry conforms to the schema", () => {
  const data = readJSON(PATHS.registry);
  for (const entry of data.questions) {
    const errors = validateRegistryEntry(entry, entry.id);
    assert.strictEqual(errors.length, 0, errors.join("; "));
  }
});

test("registry ids are unique", () => {
  const data = readJSON(PATHS.registry);
  const ids = data.questions.map((q) => q.id);
  assert.strictEqual(new Set(ids).size, ids.length, "duplicate ids found");
});

test("every claim file conforms to the schema", () => {
  assert.ok(fs.existsSync(PATHS.claimsDir), "claims dir should exist");
  const files = fs
    .readdirSync(PATHS.claimsDir)
    .filter((f) => f.endsWith(".json"));
  assert.ok(files.length > 0, "expected at least one claim file");

  for (const f of files) {
    const obj = readJSON(path.join(PATHS.claimsDir, f));
    const errors = validateClaimFile(obj, f);
    assert.strictEqual(errors.length, 0, errors.join("; "));
    // Filename must match the question_id inside.
    assert.strictEqual(
      f,
      `${obj.question_id}.json`,
      `filename ${f} must match question_id ${obj.question_id}`
    );
  }
});

test("every claim file corresponds to a registry question", () => {
  const registry = readJSON(PATHS.registry);
  const regIds = new Set(registry.questions.map((q) => q.id));
  const files = fs
    .readdirSync(PATHS.claimsDir)
    .filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    assert.ok(regIds.has(id), `claim ${id} missing from registry`);
  }
});

test("claim sources preserve real URLs (no empty urls)", () => {
  const files = fs
    .readdirSync(PATHS.claimsDir)
    .filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const obj = readJSON(path.join(PATHS.claimsDir, f));
    for (const claim of obj.claims) {
      for (const s of claim.sources) {
        assert.ok(
          typeof s.url === "string" && s.url.length > 0,
          `${f} has a source with an empty url`
        );
      }
    }
  }
});

test("edition ledger exists and is valid", () => {
  assert.ok(fs.existsSync(PATHS.ledger), "ledger should exist");
  const ledger = readJSON(PATHS.ledger);
  assert.ok(Array.isArray(ledger.editions), "editions must be array");
  assert.ok(ledger.editions.length >= 1, "at least edition 1 required");
  const first = ledger.editions[0];
  assert.strictEqual(first.edition_number, 1);
  for (const e of ledger.editions) {
    assert.ok(Number.isInteger(e.edition_number), "edition_number int");
    assert.ok(typeof e.created_at === "string", "created_at string");
    assert.ok(Array.isArray(e.questions_updated), "questions_updated array");
    assert.ok(Array.isArray(e.questions_added), "questions_added array");
    assert.ok(Array.isArray(e.questions_deprecated), "q_deprecated array");
    assert.ok(typeof e.author === "string", "author string");
  }
});
