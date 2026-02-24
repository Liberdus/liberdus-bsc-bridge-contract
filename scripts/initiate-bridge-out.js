const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const CONTRACT_ADDRESS = process.env.VAULT_ADDRESS;
  if (!CONTRACT_ADDRESS) {
    throw new Error("Set VAULT_ADDRESS in your .env file");
  }

  const [deployer] = await hre.ethers.getSigners();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const amount = ethers.parseUnits(process.env.AMOUNT_LIB || "100", 18);
  const targetAddress = process.env.TARGET_ADDRESS || deployer.address;

  console.log("Using account:", deployer.address);
  console.log("Chain ID:", Number(chainId));
  console.log("Contract Address:", CONTRACT_ADDRESS);

  const contract = await hre.ethers.getContractAt("Vault", CONTRACT_ADDRESS);

  const bridgeOutEnabled = await contract.bridgeOutEnabled();
  console.log("bridgeOutEnabled:", bridgeOutEnabled);
  if (!bridgeOutEnabled) {
    throw new Error("Vault bridgeOut is disabled. Enable it via multisig first.");
  }

  const tokenAddress = await contract.token();
  const tokenContract = new ethers.Contract(
    tokenAddress,
    [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ],
    deployer
  );

  const balance = await tokenContract.balanceOf(deployer.address);
  console.log("Token Address:", tokenAddress);
  console.log("Current Balance:", ethers.formatUnits(balance, 18), "LIB");
  if (balance < amount) {
    throw new Error(`Insufficient balance to bridge out. Have ${ethers.formatUnits(balance, 18)}, need ${ethers.formatUnits(amount, 18)}`);
  }

  const allowance = await tokenContract.allowance(deployer.address, CONTRACT_ADDRESS);
  if (allowance < amount) {
    console.log(`Approving Vault for ${ethers.formatUnits(amount, 18)} LIB...`);
    const approveTx = await tokenContract.approve(CONTRACT_ADDRESS, amount);
    await approveTx.wait();
  }

  console.log(`\nBridging out ${ethers.formatUnits(amount, 18)} LIB to ${targetAddress} on destination chain...`);
  const tx = await contract.bridgeOut(amount, targetAddress, chainId);
  const receipt = await tx.wait();
  console.log("Transaction hash:", receipt.hash);

  const newBalance = await tokenContract.balanceOf(deployer.address);
  console.log("New Balance:", ethers.formatUnits(newBalance, 18), "LIB");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
