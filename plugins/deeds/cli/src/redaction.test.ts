import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { redactSecrets } from "./analyze.ts";
import { hasSecretShape, redactSecretValues, SECRET_ASSIGNMENT } from "./jev/facts.ts";

// Placeholders only. Armor headers are assembled at runtime from their parts.
// The differential tests run the previous patterns as a reference, which takes a while.
setDefaultTimeout(120_000);

const FILL = "EXAMPLE_NOT_A_SECRET";
const armor = (open: string, label: string, close: string) => `${open}${label}${close}`;
const PGP = (kind: "BEGIN" | "END") => armor(`-----${kind} `, "PGP PRIVATE KEY BLOCK", "-----");
const SSH2 = (kind: "BEGIN" | "END") => armor(`---- ${kind} `, "SSH2 ENCRYPTED PRIVATE KEY", " ----");
const PEM = (kind: "BEGIN" | "END") => armor(`-----${kind} `, "OPENSSH PRIVATE KEY", "-----");
const PUTTY = ["PuTTY-User-Key-File-" + "3: ssh-ed25519", "Encryption: none", `Comment: ${FILL}`, "Public-Lines: 1", FILL, "Private-Lines: 1", FILL, "Private-MAC: 00ff00ff"].join("\n");

const red = (s: string) => redactSecrets(s);

describe("private-key armor", () => {
  for (const [name, block] of [
    ["OpenPGP", `${PGP("BEGIN")}\n\n${FILL}\n${FILL}\n${PGP("END")}`],
    ["SSH2", `${SSH2("BEGIN")}\nComment: "${FILL}"\n${FILL}\n${SSH2("END")}`],
    ["PEM", `${PEM("BEGIN")}\n${FILL}\n${PEM("END")}`],
    ["PuTTY", PUTTY],
  ] as const) {
    test(`${name}: the whole block is replaced, and only it`, () => {
      const r = red(`before\n${block}\nafter`);
      expect(r.text).toBe("before\n[REDACTED]\nafter");
      expect(r.redactions).toBe(1);
      expect(redactSecretValues(`before\n${block}\nafter`)).toBe("before\n[REDACTED]\nafter");
    });
    test(`${name}: a block whose END is cut off takes the rest of the text`, () => {
      const cut = block.split("\n").slice(0, -1).join("\n");
      expect(red(`before\n${cut}`).text).toBe("before\n[REDACTED]");
    });
    test(`${name}: the gate sees an unredacted header`, () => {
      expect(hasSecretShape(block)).toBe(true);
      expect(hasSecretShape(redactSecretValues(block))).toBe(false);
    });
  }
});

describe("passwords under password-like names", () => {
  const cases: [string, string][] = [
    ["DB_PASSWORD=EXAMPLE NOT A SECRET!", "DB_PASSWORD=[REDACTED]"],
    ["DB_PASS=x1", "DB_PASS=[REDACTED]"],
    ['password: "short"', 'password: "[REDACTED]"'],
    ["  password: two words # comment", "  password: [REDACTED]"],
    ["PGPASSWORD=abc", "PGPASSWORD=[REDACTED]"],
    ["export MYSQL_PWD='p@ss w0rd;'", "export MYSQL_PWD='[REDACTED]'"],
    ['"passphrase": "correct horse"', '"passphrase": "[REDACTED]"'],
    ["pass=abc", "pass=[REDACTED]"],
  ];
  for (const [input, want] of cases) test(input, () => expect(red(input).text).toBe(want));

  const kept = ["bypass = true", "compass: north", "if (password === other) {", "x = password == y", "const cwd = process.cwd()", "password_hash = compute()", "onPass => go()", "passport: valid"];
  for (const input of kept) test(`left alone: ${input}`, () => expect(red(input)).toEqual({ text: input, redactions: 0 }));

  test("the gate is clean after redaction of a URL password", () => {
    expect(hasSecretShape(redactSecretValues("postgres://user:EXAMPLEpw@db.example.invalid/x"))).toBe(false);
  });
});

// ── Unchanged readings: the previous patterns, as the reference ──────────────────────────────────────────────
const OLD_CONTEXTS = [
  /(\b(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/-]{16,}=*)/g,
  /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:)([^@\s/'"]{3,})(?=@)/gi,
  /([A-Za-z0-9_.-]*(?:key|secret|token|passw(?:or)?d|pwd|credential|auth|private)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["'`])([^"'`\s]{12,})(?=["'`])/gi,
  /([A-Za-z0-9_.-]*(?:key|secret|token|passw(?:or)?d|pwd|credential|auth|private)[A-Za-z0-9_.-]*\s*[:=]\s*)(?=[A-Za-z0-9_+/=.-]*\d)([A-Za-z0-9_+/=.-]{12,})/gi,
];
const OLD_ASSIGNMENT = /(\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*(?:\\?["'])?\s*[=:]\s*(?:\\?["'])?)[A-Za-z0-9._/+~-]{12,}/gi;

function oldContexts(text: string): { text: string; redactions: number } {
  let n = 0;
  let out = text;
  for (const re of OLD_CONTEXTS) out = out.replace(re, (_m, head: string) => (n++, `${head}[REDACTED]`));
  return { text: out, redactions: n };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// No password-name endings (pass, pwd, passwd, password, passphrase) and no armor, so only the unchanged
// patterns can fire; secret-like words, separators, quotes and digits are frequent.
const PIECES = ["key", "KEY", "auth", "token", "secret", "credential", "private", "api_", "_", ".", "-", "=", "=", ":", " ", '"', "'", "`", "1", "2", "9", "abc", "XYZ", "+", "/", "\\", "\n", "Bearer ", "x://u:", "@"];
const randomLine = (next: () => number) => {
  let s = "";
  const n = 1 + Math.floor(next() * 24);
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(next() * PIECES.length)];
  return s;
};

describe("a password rule never hides a neighbouring secret", () => {
  test("a key after a password on the same line is still redacted", () => {
    const line = `const config = { password: null, apiKey: "abcdefghijklmnop1" };`;
    expect(redactSecrets(line).text).not.toContain("abcdefghijklmnop1");
    expect(redactSecretValues(line)).not.toContain("abcdefghijklmnop1");
    const env = "DB_PASS=s3cr3t API_TOKEN=abcdefghijklmnop12";
    expect(redactSecrets(env).text).not.toContain("abcdefghijklmnop12");
    expect(redactSecrets(env).text).not.toContain("s3cr3t");
    const escaped = String.raw`"{password: null, apiKey: \"abcdefghijklmnop\"}"`;
    expect(redactSecretValues(escaped)).not.toContain("abcdefghijklmnop");
    expect(redactSecrets("password: hunter2 x!").text).toBe("password: [REDACTED]");
    const shell = String.raw`DB_PASS=short API_KEY=\"abcdefghijklmnop123\"`;
    expect(redactSecretValues(shell)).not.toContain("abcdefghijklmnop123");
    expect(redactSecrets("DB_PASS=short API_KEY=abcdefghijklmnop123").text).not.toContain("abcdefghijklmnop123");
    expect(redactSecrets(String.raw`DB_PASS='\hunter2'`).text).toBe("DB_PASS='[REDACTED]'");
    expect(redactSecrets(String.raw`DB_PASS='abc\def'`).text).toBe("DB_PASS='[REDACTED]'");
    expect(redactSecrets(String.raw`{\"password\": \"s3cr3t pass\"}`).text).not.toContain("s3cr3t");
  });
});

describe("unchanged readings", () => {
  test("redactSecrets matches the previous name=value patterns on random short strings", () => {
    const next = rng(5);
    let diffs = 0;
    let hits = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const s = randomLine(next);
      const was = oldContexts(s);
      const now = redactSecrets(s);
      if (was.redactions) hits++;
      if (was.text !== now.text || was.redactions !== now.redactions) {
        if (++diffs <= 5) console.error("differs:", JSON.stringify(s), JSON.stringify(was), JSON.stringify(now));
      }
    }
    console.log(`redactSecrets differential: ${N} strings, ${hits} with a redaction, ${diffs} differences`);
    expect(hits).toBeGreaterThan(N / 50);
    expect(diffs).toBe(0);
  });

  test("SECRET_ASSIGNMENT matches the previous pattern on random short strings", () => {
    const next = rng(7);
    let diffs = 0;
    let hits = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const s = randomLine(next);
      const was = s.replace(OLD_ASSIGNMENT, (_m, name: string) => `${name}[R]`);
      const now = s.replace(SECRET_ASSIGNMENT, (_m, name: string) => `${name}[R]`);
      if (was !== s) hits++;
      if (was !== now && ++diffs <= 5) console.error("differs:", JSON.stringify(s), JSON.stringify(was), JSON.stringify(now));
    }
    console.log(`SECRET_ASSIGNMENT differential: ${N} strings, ${hits} with a match, ${diffs} differences`);
    expect(hits).toBeGreaterThan(N / 50);
    expect(diffs).toBe(0);
  });
});

describe("linear on 60k-character lines", () => {
  const LONG: [string, string][] = [
    ["x", "x".repeat(60_000)],
    ["auth", "auth".repeat(15_000)],
    ["key=", "key=".repeat(15_000)],
    ["token_", "token_".repeat(10_000)],
    ["password=", "password=".repeat(6_667)],
    ["pass_", "pass_".repeat(12_000)],
    ["KEYKEY", "KEY".repeat(20_000)],
    ["PGP headers", PGP("BEGIN").repeat(Math.ceil(60_000 / PGP("BEGIN").length))],
    ["-----BEGIN ", "-----BEGIN ".repeat(5_455)],
    ["SSH2 headers", SSH2("BEGIN").repeat(Math.ceil(60_000 / SSH2("BEGIN").length))],
    ["PuTTY headers", "PuTTY-User-Key-File-1:".repeat(2_728)],
  ];
  for (const [name, line] of LONG) {
    test(name, () => {
      const t0 = performance.now();
      redactSecrets(line);
      const t1 = performance.now();
      redactSecretValues(line);
      const t2 = performance.now();
      hasSecretShape(line);
      const t3 = performance.now();
      console.log(`60k ${name}: redactSecrets ${(t1 - t0).toFixed(0)} ms, redactSecretValues ${(t2 - t1).toFixed(0)} ms, gate ${(t3 - t2).toFixed(0)} ms`);
      // Generous for a loaded machine; before this change the auth line alone took over 40 s at 4k characters.
      expect(t3 - t0).toBeLessThan(6000);
    });
  }
});
