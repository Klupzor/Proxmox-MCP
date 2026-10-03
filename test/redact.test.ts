import { describe, expect, it } from "vitest";
import { isSecretKey, REDACTED, redactComposeText, redactDeep, redactString } from "../src/security/redact.js";

describe("isSecretKey", () => {
  it.each(["DB_PASSWORD", "apiKey", "API_KEY", "SECRET_KEY_BASE", "GITHUB_TOKEN", "cipassword", "DB_PASS", "BASIC_AUTH"])(
    "%s is secret",
    (k) => expect(isSecretKey(k)).toBe(true),
  );
  it.each(["KEYCLOAK_URL", "AUTHOR", "LOG_LEVEL", "TZ", "PUID", "PASSAGE"])("%s is not secret", (k) =>
    expect(isSecretKey(k)).toBe(false),
  );
});

describe("redactString", () => {
  it("redacts KEY=VALUE env entries", () => {
    expect(redactString("POSTGRES_PASSWORD=supersecret")).toBe(`POSTGRES_PASSWORD=${REDACTED}`);
    expect(redactString("TZ=Europe/Madrid")).toBe("TZ=Europe/Madrid");
    expect(redactString("API_TOKEN=${API_TOKEN}")).toBe("API_TOKEN=${API_TOKEN}");
  });

  it("redacts credentials in URLs and known token formats", () => {
    expect(redactString("postgres://app:s3cr3t@db:5432/app")).toBe(`postgres://app:${REDACTED}@db:5432/app`);
    expect(redactString("token ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(`token ${REDACTED}`);
    expect(redactString("Authorization: PVEAPIToken=a@pve!b=uuid")).toBe(`Authorization: ${REDACTED}`);
  });

  it("does not treat multi-line text as one KEY=VALUE", () => {
    expect(redactString("A=1\nB=2")).toBe("A=1\nB=2");
  });
});

describe("redactDeep", () => {
  it("redacts by key, {name,value} pairs and nested env arrays", () => {
    const out = redactDeep({
      cipassword: "x",
      Env: [{ name: "DB_PASSWORD", value: "x" }, { name: "TZ", value: "UTC" }],
      Config: { Env: ["SECRET=abc", "PATH=/usr/bin"] },
      vmid: 105,
    });
    expect(out).toEqual({
      cipassword: REDACTED,
      Env: [{ name: "DB_PASSWORD", value: REDACTED }, { name: "TZ", value: "UTC" }],
      Config: { Env: [`SECRET=${REDACTED}`, "PATH=/usr/bin"] },
      vmid: 105,
    });
  });
});

describe("redactComposeText", () => {
  it("redacts inline secrets but keeps interpolations and formatting", () => {
    const text = [
      "services:",
      "  db:",
      "    environment:",
      "      POSTGRES_PASSWORD: hunter2 # inline",
      "      API_TOKEN: ${API_TOKEN}",
      "      - JWT_SECRET=abc",
      "      LOG_LEVEL: info",
    ].join("\n");
    expect(redactComposeText(text)).toBe(
      [
        "services:",
        "  db:",
        "    environment:",
        `      POSTGRES_PASSWORD: ${REDACTED} # inline`,
        "      API_TOKEN: ${API_TOKEN}",
        `      - JWT_SECRET=${REDACTED}`,
        "      LOG_LEVEL: info",
      ].join("\n"),
    );
  });
});
