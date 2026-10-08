const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const EvidenceRegistry = await ethers.getContractFactory("EvidenceRegistry");
  const registry = await EvidenceRegistry.deploy();
  await registry.waitForDeployment();

  const output = {
    network: network.name,
    chainId: Number(network.config.chainId),
    contractAddress: await registry.getAddress(),
    deployedAt: new Date().toISOString()
  };
  const outputDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "local.json"), JSON.stringify(output, null, 2));
  console.log("EvidenceRegistry deployed:", output.contractAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
