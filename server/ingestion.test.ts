import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { validateHppDataset } from "./ingestion";

const validCsv = [
  "Call ID,Member ID,Renewal Date,Call Status,Reachable (Yes/No),1st Attempt Comments",
  "JHPPJul26-Aixa-000001,640238971,7/30/2026,NFCN3 - 3rd Round Calls Completed - No Further Contact Needed,No,16 - Client hung up",
].join("\n");

describe("HPP dataset validation", () => {
  it("accepts a source with required HPP headers and produces a stable provenance hash", async () => {
    const result = await validateHppDataset({ originalname: "hpp-july.csv", buffer: Buffer.from(validCsv) });
    expect(result.valid).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.recognizedHeaders).toContain("Call Status");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects sources missing required report-mapping headers", async () => {
    const result = await validateHppDataset({ originalname: "invalid.csv", buffer: Buffer.from("Call ID,Member ID\nabc,123") });
    expect(result.valid).toBe(false);
    expect(result.missingHeaders).toEqual(expect.arrayContaining(["Renewal Date", "Call Status", "Reachable (Yes/No)"]));
  });

  it("reads HPP headers from a permitted XLSX workbook without evaluating formulas", async () => {
    const shared = ["Call ID", "Member ID", "Renewal Date", "Call Status", "Reachable (Yes/No)"];
    const xlsx = zipSync({
      "xl/sharedStrings.xml": strToU8(`<sst count="5" uniqueCount="5">${shared.map(value => `<si><t>${value}</t></si>`).join("")}</sst>`),
      "xl/worksheets/sheet1.xml": strToU8("<worksheet><sheetData><row r=\"1\">" + shared.map((_value, index) => `<c t=\"s\"><v>${index}</v></c>`).join("") + "</row><row r=\"2\"><c><v>1</v></c></row></sheetData></worksheet>"),
    });
    const result = await validateHppDataset({ originalname: "hpp-july.xlsx", buffer: xlsx });
    expect(result.valid).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.recognizedHeaders).toEqual(expect.arrayContaining(shared));
  });
});
