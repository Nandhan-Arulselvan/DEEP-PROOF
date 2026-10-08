const { expect } = require("chai");
const { assertPdf, sha256Buffer } = require("../lib/documentIntegrity");

describe("document integrity helpers", function () {
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

  it("calculates deterministic SHA-256 hashes from the original bytes", function () {
    expect(sha256Buffer(pdf)).to.equal("fd3658488539b686d28a131d4d469ddfe40d6bc704d7b53d7bc9fef9d3e4d720");
    expect(sha256Buffer(Buffer.concat([pdf, Buffer.from("changed")]))).not.to.equal(sha256Buffer(pdf));
  });

  it("accepts a PDF signature and rejects a disguised non-PDF", function () {
    expect(() => assertPdf(pdf)).not.to.throw();
    expect(() => assertPdf(Buffer.from("not a pdf"))).to.throw("not a valid PDF");
  });

  it("rejects empty uploads", function () {
    expect(() => assertPdf(Buffer.alloc(0))).to.throw("non-empty PDF");
  });
});
