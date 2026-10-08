require("@nomicfoundation/hardhat-toolbox");

/** A local EVM network is Polygon-compatible for this Review 1 contract demo. */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 }
  }
};
