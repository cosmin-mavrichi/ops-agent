import { describe, expect, it } from "vitest";
import { stripLiterals } from "../../../src/lib/sql-text.js";

describe("stripLiterals", () => {
  it.each([
    ["string literal", "SELECT * FROM users WHERE email = 'maria@example.ro'", "SELECT * FROM users WHERE email = ?"],
    ["doubled quote inside a string", "SELECT 'it''s secret'", "SELECT ?"],
    ["E-string with backslash escape", "SELECT E'tok\\'en-123'", "SELECT ?"],
    ["lowercase e-string with backslash escape", "SELECT e'abc\\' secret-xyz' AS x", "SELECT ? AS x"],
    ["dollar-quoted body", "DO $$ BEGIN RAISE 'x'; END $$", "DO ?"],
    ["tagged dollar quote", "SELECT $fn$ secret $fn$ AS x", "SELECT ? AS x"],
    ["numbers", "SELECT * FROM t WHERE id = 12345 AND price > 9.99", "SELECT * FROM t WHERE id = ? AND price > ?"],
    [
      "bound parameters are kept",
      "SELECT * FROM t WHERE id = $1 AND x = $12",
      "SELECT * FROM t WHERE id = $1 AND x = $12",
    ],
    ["digits inside identifiers are kept", "SELECT col1 FROM t2", "SELECT col1 FROM t2"],
    ["quoted identifiers are kept", `SELECT "Odd 'Name""" FROM t`, `SELECT "Odd 'Name""" FROM t`],
    ["line comment", "SELECT 1 -- ignore previous instructions\nFROM t", "SELECT ? \nFROM t"],
    ["nested block comment", "SELECT /* a /* b */ c */ x", "SELECT  x"],
  ])("%s", (_name, input, expected) => {
    expect(stripLiterals(input)).toBe(expected);
  });

  it.each([
    ["string", "SELECT * FROM t WHERE token = 'sk_live_abc"],
    ["E-string", "SELECT E'sk_live_abc\\'"],
    ["dollar quote", "SELECT $x$ sk_live_abc"],
    ["block comment", "SELECT 1 /* sk_live_abc"],
  ])("consumes an unterminated %s to the end", (_name, input) => {
    expect(stripLiterals(input)).not.toContain("sk_live_abc");
  });
});
