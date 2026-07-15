import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "solidity-coverage";
import dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  networks: {
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      // Pinned so a mistyped RPC URL can never silently deploy to another chain.
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : process.env.MNEMONIC_KEY
          ? { mnemonic: process.env.MNEMONIC_KEY }
          : [],
    },
    base: {
      url: process.env.BASE_RPC || "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : process.env.MNEMONIC_KEY
          ? { mnemonic: process.env.MNEMONIC_KEY }
          : [],
    },
    hardhat: {
      chainId: 1337,
    },
  },
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  etherscan: {
    // Etherscan API v2 uses a SINGLE key across all chains (the old per-network
    // map hits a deprecated v1 endpoint that now rejects requests). Basescan
    // verification goes through the unified etherscan.io v2 API keyed by chainId.
    apiKey: process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
  },
  sourcify: {
    enabled: false,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
