const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("EvidenceRegistry", function () {
  const hash = "0x" + "ab".repeat(32);

  async function deployRegistry() {
    const Registry = await ethers.getContractFactory("EvidenceRegistry");
    return Registry.deploy();
  }

  it("registers a document hash and exposes its audit details", async function () {
    const registry = await deployRegistry();
    const [owner] = await ethers.getSigners();
    await expect(registry.registerEvidence(hash))
      .to.emit(registry, "EvidenceRegistered")
      .withArgs(hash, owner.address, anyValue);

    const evidence = await registry.getEvidence(hash);
    expect(evidence.registeredBy).to.equal(owner.address);
    expect(evidence.exists).to.equal(true);
    expect(evidence.registeredAt).to.be.greaterThan(0);
  });

  it("prevents duplicate registration", async function () {
    const registry = await deployRegistry();
    await registry.registerEvidence(hash);
    await expect(registry.registerEvidence(hash))
      .to.be.revertedWithCustomError(registry, "EvidenceAlreadyRegistered")
      .withArgs(hash);
  });

  it("reports an unknown hash as unverified", async function () {
    const registry = await deployRegistry();
    const evidence = await registry.getEvidence("0x" + "cd".repeat(32));
    expect(evidence.exists).to.equal(false);
  });
});
