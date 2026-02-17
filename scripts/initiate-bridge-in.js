const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const CONTRACT_TYPE = (process.env.CONTRACT_TYPE || "SECONDARY").toUpperCase();
  let CONTRACT_ADDRESS;
  let CONTRACT_NAME;

  if (CONTRACT_TYPE === "PRIMARY") {
    CONTRACT_ADDRESS = process.env.LIBERDUS_TOKEN_ADDRESS;
    CONTRACT_NAME = "Liberdus";
  } else if (CONTRACT_TYPE === "VAULT") {
    CONTRACT_ADDRESS = process.env.VAULT_ADDRESS;
    CONTRACT_NAME = "Vault";
  } else {
    CONTRACT_ADDRESS = process.env.LIBERDUS_SECONDARY_ADDRESS;
    CONTRACT_NAME = "LiberdusSecondary";
  }

  if (!CONTRACT_ADDRESS) {
    if (CONTRACT_TYPE === "PRIMARY") {
      throw new Error("Set LIBERDUS_TOKEN_ADDRESS in your .env file");
    }
    if (CONTRACT_TYPE === "VAULT") {
      throw new Error("Set VAULT_ADDRESS in your .env file");
    }
    throw new Error("Set LIBERDUS_SECONDARY_ADDRESS in your .env file");
  }

  const [deployer] = await hre.ethers.getSigners();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const sourceChainId = BigInt(process.env.SOURCE_CHAIN_ID || 0);
  const amount = ethers.parseUnits(process.env.AMOUNT_LIB || "10000", 18);
  const recipient = process.env.TARGET_ADDRESS || deployer.address;
  const txId = process.env.TX_ID || "testnet-bridge-in-1";

  console.log("Using account:", deployer.address);
  console.log("Chain ID:", chainId);
  console.log("Contract Type:", CONTRACT_TYPE);
  console.log("Contract Address:", CONTRACT_ADDRESS);

  // Attach to deployed contract
  const contract = await hre.ethers.getContractAt(CONTRACT_NAME, CONTRACT_ADDRESS);

  // Verify state (only primary contract has isPreLaunch)
  if (CONTRACT_TYPE === "PRIMARY") {
    const isPreLaunch = await contract.isPreLaunch();
    console.log("isPreLaunch:", isPreLaunch);
    if (isPreLaunch) {
      throw new Error("Contract is still in pre-launch mode. Redeploy with updated constructor.");
    }
  }

  const bridgeInCaller = await contract.bridgeInCaller();
  console.log("bridgeInCaller:", bridgeInCaller);
  if (bridgeInCaller.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer is not the bridgeInCaller. Expected ${deployer.address}, got ${bridgeInCaller}`);
  }

  console.log(`\nBridging in ${ethers.formatUnits(amount, 18)} LIB to ${recipient}...`);
  
  let tx;
  if (CONTRACT_TYPE === "PRIMARY") {
      tx = await contract.bridgeIn(recipient, amount, chainId, ethers.id(txId));
  } else {
      console.log("Calling bridgeIn with sourceChainId:", sourceChainId.toString());
      tx = await contract["bridgeIn(address,uint256,uint256,bytes32,uint256)"](
        recipient,
        amount,
        chainId,
        ethers.id(txId),
        sourceChainId
      );
  }

  const receipt = await tx.wait();
  console.log("Transaction hash:", receipt.hash);

  let balance;
  if (CONTRACT_TYPE === "VAULT") {
    const tokenAddress = await contract.token();
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ["function balanceOf(address) view returns (uint256)"],
      deployer
    );
    balance = await tokenContract.balanceOf(recipient);
  } else {
    balance = await contract.balanceOf(recipient);
  }
  console.log("Balance:", ethers.formatUnits(balance, 18), "LIB");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
