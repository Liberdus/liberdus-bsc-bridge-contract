const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer, signer1, signer2, signer3] = await hre.ethers.getSigners();

  // --- CONFIGURATION ---
  const LIBERDUS_ADDR = process.env.LIBERDUS_TOKEN_ADDRESS || "";
  const LIBERDUS_SEC_ADDR = process.env.LIBERDUS_SECONDARY_ADDRESS || "";
  const VAULT_ADDR = process.env.VAULT_ADDRESS || "";

  if (!LIBERDUS_ADDR || !LIBERDUS_SEC_ADDR || !VAULT_ADDR) {
    throw new Error("Set LIBERDUS_TOKEN_ADDRESS, LIBERDUS_SECONDARY_ADDRESS, and VAULT_ADDRESS in .env");
  }

  const CHAIN_ID_PRIMARY = 31337;
  const CHAIN_ID_SECONDARY = 31338;

  const balanceOnly = process.env.BALANCE_ONLY === "true" || process.env.BALANCE_ONLY === "1";

  console.log("Interacting with contracts...");
  console.log("Deployer:", deployer.address);
  console.log("Signer 1:", signer1.address);
  console.log("Signer 2:", signer2.address);
  console.log("Signer 3:", signer3.address);

  // Attach to contracts
  const Liberdus = await ethers.getContractFactory("Liberdus");
  const liberdus = Liberdus.attach(LIBERDUS_ADDR);

  const LiberdusSecondary = await ethers.getContractFactory("LiberdusSecondary");
  const liberdusSecondary = LiberdusSecondary.attach(LIBERDUS_SEC_ADDR);

  const Vault = await ethers.getContractFactory("Vault");
  const vault = Vault.attach(VAULT_ADDR);

  // ====================================================
  // TOKEN & ETH BALANCE CHECK
  // ====================================================
  console.log("\n--- Token & ETH Balances ---");
  const accounts = [
    { name: "Deployer", address: deployer.address },
    { name: "Signer 1", address: signer1.address },
    { name: "Signer 2", address: signer2.address },
    { name: "Signer 3", address: signer3.address },
  ];
  for (const account of accounts) {
    const primaryBal = await liberdus.balanceOf(account.address);
    const secondaryBal = await liberdusSecondary.balanceOf(account.address);
    const ethBal = await deployer.provider.getBalance(account.address);
    console.log(`${account.name} (${account.address}):`);
    console.log(`  Primary:   ${ethers.formatUnits(primaryBal, 18)} LIB`);
    console.log(`  Secondary: ${ethers.formatUnits(secondaryBal, 18)} LIB`);
    console.log(`  ETH:       ${ethers.formatUnits(ethBal, "ether")} ETH`);
  }
  console.log(`Vault Locked Balance: ${ethers.formatUnits(await vault.getVaultBalance(), 18)} LIB`);

  if (balanceOnly) {
    console.log("\n--- Balance check complete ---");
    return;
  }

  // ====================================================
  // 1. PRIMARY -> SECONDARY (via Vault)
  // ====================================================
  console.log("\n--- Primary -> Secondary via Vault ---");
  const bridgeOutAmount = ethers.parseUnits(process.env.BRIDGE_OUT_AMOUNT || "5", 18);

  const signer1PrimaryBal = await liberdus.balanceOf(signer1.address);
  console.log(`Signer 1 Primary Balance: ${ethers.formatUnits(signer1PrimaryBal, 18)} LIB`);
  if (signer1PrimaryBal >= bridgeOutAmount) {
    const approveTx = await liberdus.connect(signer1).approve(VAULT_ADDR, bridgeOutAmount);
    await approveTx.wait();

    const tx = await vault
      .connect(signer1)
      ["bridgeOut(uint256,address,uint256,uint256)"](
        bridgeOutAmount,
        signer1.address,
        CHAIN_ID_PRIMARY,
        CHAIN_ID_SECONDARY
      );
    await tx.wait();
    console.log("Signer 1 vault bridgeOut successful.");
    console.log(`Signer 1 Primary Remaining: ${ethers.formatUnits(await liberdus.balanceOf(signer1.address), 18)} LIB`);
    console.log(`Vault Locked Balance: ${ethers.formatUnits(await vault.getVaultBalance(), 18)} LIB`);
  } else {
    console.log(`Skipping Primary->Secondary: signer1 needs at least ${ethers.formatUnits(bridgeOutAmount, 18)} LIB.`);
  }

  // ====================================================
  // 2. SECONDARY -> PRIMARY (unlock from Vault)
  // ====================================================
  console.log("\n--- Secondary -> Primary via Vault ---");
  const bridgeBackAmount = ethers.parseUnits(process.env.BRIDGE_BACK_AMOUNT || "1", 18);
  const signer2SecondaryBal = await liberdusSecondary.balanceOf(signer2.address);
  console.log(`Signer 2 Secondary Balance: ${ethers.formatUnits(signer2SecondaryBal, 18)} LIB`);

  if (signer2SecondaryBal >= bridgeBackAmount) {
    const outTx = await liberdusSecondary
      .connect(signer2)
      ["bridgeOut(uint256,address,uint256,uint256)"](
        bridgeBackAmount,
        signer2.address,
        CHAIN_ID_SECONDARY,
        CHAIN_ID_PRIMARY
      );
    await outTx.wait();
    console.log("Signer 2 secondary bridgeOut successful.");

    const bridgeInCaller = await vault.bridgeInCaller();
    if (bridgeInCaller.toLowerCase() !== deployer.address.toLowerCase()) {
      console.log(`Skipping vault bridgeIn: deployer is not bridgeInCaller (${bridgeInCaller}).`);
    } else {
      const inTx = await vault
        .connect(deployer)
        ["bridgeIn(address,uint256,uint256,bytes32,uint256)"](
          signer2.address,
          bridgeBackAmount,
          CHAIN_ID_PRIMARY,
          ethers.id(`interact-bridge-${Date.now()}`),
          CHAIN_ID_SECONDARY
        );
      await inTx.wait();
      console.log("Vault bridgeIn to signer2 successful.");
      console.log(`Signer 2 Primary Balance: ${ethers.formatUnits(await liberdus.balanceOf(signer2.address), 18)} LIB`);
      console.log(`Vault Locked Balance: ${ethers.formatUnits(await vault.getVaultBalance(), 18)} LIB`);
    }
  } else {
    console.log(`Skipping Secondary->Primary: signer2 needs at least ${ethers.formatUnits(bridgeBackAmount, 18)} LIB.`);
  }

  console.log("\n--- Interaction Complete ---");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
