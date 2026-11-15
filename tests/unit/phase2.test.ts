import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCsv, readCsvRecords, toCsv } from "@/server/csv";
import { assertPublicUrl, isPrivateAddress, signPayload } from "@/server/webhooks/deliver";

describe("CSV", () => {
  it("reads quoted cells, doubled quotes, CRLF, a BOM and skips blank lines", () => {
    const text = '﻿name,notes\r\n"Smith, Jo","said ""hi""\nthere"\r\n\r\nLee,\n';
    expect(parseCsv(text)).toEqual([
      ["name", "notes"],
      ["Smith, Jo", 'said "hi"\nthere'],
      ["Lee", ""],
    ]);
  });

  it("matches headers loosely and requires the required ones", () => {
    const rows = readCsvRecords("Name , E-mail,Unit Price\nAda,a@x.io,5\n", ["name", "unit_price", "phone"], ["name"]);
    expect(rows).toEqual([{ name: "Ada", unit_price: "5", phone: "" }]);
    expect(() => readCsvRecords("email\na@x.io\n", ["name"], ["name"])).toThrow(/"name" column/);
    expect(() => readCsvRecords("", ["name"], ["name"])).toThrow(/empty/);
    expect(() => parseCsv('a,"b')).toThrow(/never closed/);
  });

  it("writes cells a spreadsheet will not run as formulas, and round-trips", () => {
    const rows = [{ name: '=HYPERLINK("http://evil")', amount: -12.5, notes: "a,b\n@c" }];
    const csv = toCsv(["name", "amount", "notes"], rows);
    expect(csv).toContain("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csv).toContain(",-12.5,"); // a plain negative number stays a number
    expect(toCsv(["name"], [{ name: "+1 555" }, { name: "@handle" }, { name: null }])).toBe("name\r\n'+1 555\r\n'@handle\r\n\r\n");
    expect(parseCsv(csv)[1]).toEqual(["'=HYPERLINK(\"http://evil\")", "-12.5", "a,b\n@c"]);
  });
});

describe("webhook delivery", () => {
  it("signs the timestamp and the exact body", () => {
    const signature = signPayload("whsec_test", '{"a":1}', 1700000000);
    const expected = createHmac("sha256", "whsec_test").update('1700000000.{"a":1}').digest("hex");
    expect(signature).toBe(`t=1700000000,v1=${expected}`);
    expect(signPayload("other", '{"a":1}', 1700000000)).not.toBe(signature);
  });

  it("recognises addresses a webhook must never reach", () => {
    for (const address of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
      "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:10.0.0.1", "::ffff:7f00:1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("refuses URLs that are not plain https to a public host", async () => {
    for (const url of [
      "http://example.com/hook", "https://user:pw@example.com/", "https://127.0.0.1/", "https://[::1]/",
      "https://169.254.169.254/latest/meta-data", "https://localhost/", "ftp://example.com/",
    ]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow();
    }
    await expect(assertPublicUrl("https://8.8.8.8/hook")).resolves.toBeInstanceOf(URL);
  });
});
