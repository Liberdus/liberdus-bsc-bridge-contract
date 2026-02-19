const hre = require("hardhat");
const { ethers } = hre;
const OP = Object.freeze({
  SET_BRIDGE_OUT_AMOUNT: 0,
  UPDATE_SIGNER: 1,
  SET_BRIDGE_OUT_ENABLED: 2,
  RELINQUISH_TOKENS: 3,
});

async function requestAndSignOperation(contract, signers, operationType, target, value, data) {
  const tx = await contract.requestOperation(operationType, target, value, data);
  const receipt = await tx.wait();

  const operationRequestedEvent = receipt.logs.find(log => log.fragment && log.fragment.name === 'OperationRequested');
  const operationId = operationRequestedEvent.args.operationId;

  console.log(`  Operation requested: ${operationId}`);

  for (let i = 0; i < 3; i++) {
    const messageHash = await contract.getOperationHash(operationId);
    const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
    await contract.connect(signers[i]).submitSignature(operationId, signature);
    console.log(`  Signature ${i + 1}/3 submitted by ${signers[i].address}`);
  }

  console.log(`  Operation executed.`);
  return operationId;
}

async function main() {
  const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
  const LIBERDUS_ADDRESS = process.env.LIBERDUS_TOKEN_ADDRESS;
  const ACTION = process.env.ACTION || "balance"; // balance, bridgeOut, relinquish, setBridgeOutAmount, setBridgeOutEnabled

  if (!VAULT_ADDRESS) {
    throw new Error("Set VAULT_ADDRESS in your .env file");
  }

  const allSigners = await hre.ethers.getSigners();
  const [deployer, signer1, signer2, signer3] = allSigners;
  const signers = [deployer, signer1, signer2, signer3];
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  console.log("=== Vault Interaction ===");
  console.log("Vault Address:", VAULT_ADDRESS);
  console.log("Chain ID:", Number(chainId));
  console.log("Action:", ACTION);
  console.log("Deployer:", deployer.address);

  const vault = await hre.ethers.getContractAt("Vault", VAULT_ADDRESS);

  // --- BALANCE CHECK ---
  if (ACTION === "balance") {
    const vaultBalance = await vault.getVaultBalance();
    console.log(`\nVault Balance: ${ethers.formatUnits(vaultBalance, 18)} LIB`);

    const maxBridgeOutAmount = await vault.maxBridgeOutAmount();
    console.log(`Max Bridge Out Amount: ${ethers.formatUnits(maxBridgeOutAmount, 18)} LIB`);

    const bridgeOutEnabled = await vault.bridgeOutEnabled();
    console.log(`Bridge Out Enabled: ${bridgeOutEnabled}`);

    for (const account of [
      { name: "Deployer", address: deployer.address },
      { name: "Signer 1", address: signer1.address },
      { name: "Signer 2", address: signer2.address },
      { name: "Signer 3", address: signer3.address },
    ]) {
      const isSigner = await vault.isSigner(account.address);
      console.log(`${account.name} (${account.address}): isSigner=${isSigner}`);
    }
    return;
  }

  // --- BRIDGE OUT ---
  if (ACTION === "bridgeOut") {
    if (!LIBERDUS_ADDRESS) {
      throw new Error("Set LIBERDUS_TOKEN_ADDRESS in your .env file");
    }

    const erc20Abi = [
      "function balanceOf(address account) view returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)",
    ];
    const liberdus = new ethers.Contract(LIBERDUS_ADDRESS, erc20Abi, deployer);
    const amount = ethers.parseUnits(process.env.AMOUNT || "100", 18);
    const targetAddress = process.env.TARGET_ADDRESS || deployer.address;

    const balance = await liberdus.balanceOf(deployer.address);
    console.log(`\nCurrent Balance: ${ethers.formatUnits(balance, 18)} LIB`);

    if (balance < amount) {
      throw new Error(`Insufficient balance. Have ${ethers.formatUnits(balance, 18)}, need ${ethers.formatUnits(amount, 18)}`);
    }

    // Approve vault
    console.log(`Approving vault for ${ethers.formatUnits(amount, 18)} LIB...`);
    const approveTx = await liberdus.connect(deployer).approve(VAULT_ADDRESS, amount);
    await approveTx.wait();

    // Bridge out
    console.log(`Bridging out ${ethers.formatUnits(amount, 18)} LIB to ${targetAddress}...`);
    const tx = await vault.connect(deployer).bridgeOut(amount, targetAddress, chainId);
    const receipt = await tx.wait();
    console.log("Transaction hash:", receipt.hash);

    const newBalance = await liberdus.balanceOf(deployer.address);
    console.log(`New Balance: ${ethers.formatUnits(newBalance, 18)} LIB`);
    console.log(`Vault Balance: ${ethers.formatUnits(await vault.getVaultBalance(), 18)} LIB`);
    return;
  }

  // --- SET BRIDGE OUT ENABLED ---
  if (ACTION === "setBridgeOutEnabled") {
    const enabledRaw = process.env.BRIDGE_OUT_ENABLED;
    if (enabledRaw === undefined) {
      throw new Error("Set BRIDGE_OUT_ENABLED=true|false in your .env file");
    }
    const normalized = String(enabledRaw).trim().toLowerCase();
    if (!["true", "false", "1", "0"].includes(normalized)) {
      throw new Error("BRIDGE_OUT_ENABLED must be one of: true, false, 1, 0");
    }
    const enabled = normalized === "true" || normalized === "1";
    const current = await vault.bridgeOutEnabled();
    if (current === enabled) {
      console.log(`Bridge Out Enabled already ${enabled}, skipping.`);
      return;
    }
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [enabled]);
    await requestAndSignOperation(vault, signers, OP.SET_BRIDGE_OUT_ENABLED, ethers.ZeroAddress, 0, data);
    console.log(`Bridge Out Enabled set to: ${await vault.bridgeOutEnabled()}`);
    return;
  }

  // --- SET BRIDGE OUT LIMITS ---
  if (ACTION === "setBridgeOutAmount") {
    const maxAmountRaw = process.env.MAX_BRIDGE_OUT_AMOUNT;
    if (!maxAmountRaw) {
      throw new Error("Set MAX_BRIDGE_OUT_AMOUNT in your .env file");
    }
    const newMaxAmount = ethers.parseUnits(maxAmountRaw, 18);
    if (newMaxAmount <= 0n) {
      throw new Error("MAX_BRIDGE_OUT_AMOUNT must be greater than zero");
    }
    const current = await vault.maxBridgeOutAmount();
    if (current === newMaxAmount) {
      console.log(`Max Bridge Out Amount already ${ethers.formatUnits(newMaxAmount, 18)} LIB, skipping.`);
      return;
    }
    await requestAndSignOperation(vault, signers, OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, newMaxAmount, "0x");
    console.log(`Max Bridge Out Amount set to: ${ethers.formatUnits(await vault.maxBridgeOutAmount(), 18)} LIB`);
    return;
  }

  // --- RELINQUISH TOKENS ---
  if (ACTION === "relinquish") {
    const vaultBalance = await vault.getVaultBalance();
    console.log(`\nVault Balance: ${ethers.formatUnits(vaultBalance, 18)} LIB`);
    console.log("Relinquishing all tokens to Liberdus contract and permanently halting vault...");

    await requestAndSignOperation(vault, signers, OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x");

    console.log(`Vault Balance after relinquish: ${ethers.formatUnits(await vault.getVaultBalance(), 18)} LIB`);
    console.log(`Vault halted: ${await vault.halted()}`);
    return;
  }

  console.error(`Unknown action: ${ACTION}. Use one of: balance, bridgeOut, setBridgeOutAmount, setBridgeOutEnabled, relinquish`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
