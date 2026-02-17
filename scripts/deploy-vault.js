const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const TOKEN_ADDRESS = process.env.LIBERDUS_TOKEN_ADDRESS || "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  if (!TOKEN_ADDRESS) {
    throw new Error("Set LIBERDUS_TOKEN_ADDRESS in your .env file (the deployed Liberdus contract address)");
  }

  const [deployer] = await hre.ethers.getSigners();

  console.log("Deploying Vault with the account:", deployer.address);
  console.log(
    "Account balance:",
    (await deployer.provider.getBalance(deployer.address)).toString(),
  );

  // Get chainId from the network
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  // Use configured signers for the network
  const signerAddresses = hre.config.namedAccounts.signers[hre.network.name];
  if (!signerAddresses) {
    throw new Error(`No signers configured for network: ${hre.network.name}`);
  }

  console.log("Token address:", TOKEN_ADDRESS);
  console.log("Using chainId:", chainId);
  console.log("Using signers:", signerAddresses);

  // Deploy Vault
  const Vault = await hre.ethers.getContractFactory("Vault");
  const vault = await Vault.deploy(TOKEN_ADDRESS, signerAddresses, chainId);

  await vault.waitForDeployment();

  const contractAddress = await vault.getAddress();
  console.log("Vault deployed to:", contractAddress);
  console.log("Initial signers:");
  signerAddresses.forEach((signer, index) => {
    console.log(`  Signer ${index + 1}:`, signer);
  });

  // Wait for block confirmations then verify
  console.log("Waiting for block confirmations...");
  await vault.deploymentTransaction().wait(6);

  console.log("Verifying contract...");
  try {
    await hre.run("verify:verify", {
      address: contractAddress,
      constructorArguments: [TOKEN_ADDRESS, signerAddresses, chainId],
    });
    console.log("Contract verified successfully");
  } catch (error) {
    console.error("Verification failed:", error.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
