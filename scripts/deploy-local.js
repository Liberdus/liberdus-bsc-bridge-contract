const hre = require("hardhat");
const { ZeroAddress } = require("hardhat").ethers;
const { ethers } = hre;
const SECONDARY_OP = Object.freeze({
  SET_BRIDGE_IN_CALLER: 2,
  SET_BRIDGE_OUT_ENABLED: 6,
});

async function main() {
  const [deployer, signer1, signer2, signer3] = await hre.ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);
  console.log(
    "Account balance:",
    (await deployer.provider.getBalance(deployer.address)).toString(),
  );

  // --- CONFIGURATION ---
  // Simulate two chains
  const CHAIN_ID_PRIMARY = 31337;
  const CHAIN_ID_SECONDARY = 31338;

  let signerAddresses;
  let signers;

  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    signerAddresses = [
      deployer.address,
      signer1.address,
      signer2.address,
      signer3.address,
    ];
    signers = [deployer, signer1, signer2, signer3];
  } else {
    // For non-local, just use configured signers (simplified for this script's scope)
    signers = hre.config.namedAccounts.signers[hre.network.name];
    signerAddresses = signers; // Assuming these are addresses
  }

  // --- HELPER FUNCTION ---
  async function requestAndSignOperation(contract, operationType, target, value, data) {
    const tx = await contract.requestOperation(
      operationType,
      target,
      value,
      data,
    );
    const receipt = await tx.wait();

    const operationRequestedEvent = receipt.logs.find(
      (log) => log.fragment.name === "OperationRequested",
    );
    const operationId = operationRequestedEvent.args.operationId;

    // Sign with 3 signers
    for (let i = 0; i < 3; i++) {
      const messageHash = await contract.getOperationHash(operationId);
      const signature = await signers[i].signMessage(
        ethers.getBytes(messageHash),
      );
      await contract
        .connect(signers[i])
        .submitSignature(operationId, signature);
    }
    return operationId;
  }

  // ====================================================
  // 1. DEPLOY LIBERDUS (PRIMARY)
  // ====================================================
  console.log("\n--- Deploying Liberdus (Primary Chain: 31337) ---");
  const LiberdusToken = await hre.ethers.getContractFactory("Liberdus");
  const liberdus = await LiberdusToken.deploy(signerAddresses, CHAIN_ID_PRIMARY);
  await liberdus.waitForDeployment();
  console.log(`Liberdus deployed to: ${await liberdus.getAddress()}`);

  // ====================================================
  // 2. DEPLOY VAULT (PRIMARY CHAIN LOCKER)
  // ====================================================
  console.log("\n--- Deploying Vault (Primary Chain: 31337) ---");
  const Vault = await hre.ethers.getContractFactory("Vault");
  const vault = await Vault.deploy(await liberdus.getAddress(), signerAddresses, CHAIN_ID_PRIMARY);
  await vault.waitForDeployment();
  console.log(`Vault deployed to: ${await vault.getAddress()}`);

  // ====================================================
  // 3. DEPLOY LIBERDUS SECONDARY (SECONDARY)
  // ====================================================
  console.log("\n--- Deploying LiberdusSecondary (Secondary Chain: 31338) ---");
  const LiberdusSecondaryToken = await hre.ethers.getContractFactory("LiberdusSecondary");
  const liberdusSecondary = await LiberdusSecondaryToken.deploy(signerAddresses, CHAIN_ID_SECONDARY);
  await liberdusSecondary.waitForDeployment();
  console.log(`LiberdusSecondary deployed to: ${await liberdusSecondary.getAddress()}`);


  // ====================================================
  // 4. SETUP PRIMARY CHAIN (PRE-LAUNCH)
  // ====================================================
  console.log("\n--- Setting up Liberdus (Primary) ---");

  // Mint (OpType 0)
  console.log("Minting tokens...");
  await requestAndSignOperation(liberdus, 0, deployer.address, 0, "0x");

  // Distribute (OpType 8)
  console.log("Distributing 500000 tokens to deployer...");
  const distributionAmount = ethers.parseUnits("500000", 18);
  await requestAndSignOperation(liberdus, 8, deployer.address, distributionAmount, "0x");

  // Set BridgeInCaller (OpType 5) - allowing deployer to act as bridge for testing
  console.log("Setting BridgeInCaller to deployer...");
  await requestAndSignOperation(liberdus, 5, deployer.address, 0, "0x");


  // ====================================================
  // 5. SETUP VAULT + SECONDARY CHAIN
  // ====================================================
  console.log("\n--- Setting up Vault + LiberdusSecondary ---");

  // Set BridgeInCaller (OpType 2) - allowing deployer to act as bridge
  console.log("Setting Secondary BridgeInCaller to deployer...");
  await requestAndSignOperation(
    liberdusSecondary,
    SECONDARY_OP.SET_BRIDGE_IN_CALLER,
    deployer.address,
    0,
    "0x"
  );

  // Enable bridgeOut for local bridge round-trip tests.
  if (!(await liberdusSecondary.bridgeOutEnabled())) {
    console.log("Enabling Secondary bridgeOut...");
    const enableBridgeOutData = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
    await requestAndSignOperation(
      liberdusSecondary,
      SECONDARY_OP.SET_BRIDGE_OUT_ENABLED,
      ZeroAddress,
      0,
      enableBridgeOutData
    );
  }


  // ====================================================
  // 6. INTERACTION: BRIDGE OUT (Vault/Primary -> Secondary)
  // ====================================================
  console.log("\n--- Interaction: Bridge Out (Vault/Primary -> Secondary) ---");
  const bridgeAmount = ethers.parseUnits("10000", 18);

  console.log(`Approving Vault for ${ethers.formatUnits(bridgeAmount, 18)} LIB on Primary...`);
  await liberdus.connect(deployer).approve(await vault.getAddress(), bridgeAmount);

  console.log(`Bridging out ${ethers.formatUnits(bridgeAmount, 18)} LIB via Vault...`);
  const txOut1 = await vault
    .connect(deployer)
    ["bridgeOut(uint256,address,uint256,uint256)"](
      bridgeAmount,
      deployer.address,
      CHAIN_ID_PRIMARY,
      CHAIN_ID_SECONDARY
    );
  await txOut1.wait();

  console.log("Primary Balance:", ethers.formatUnits(await liberdus.balanceOf(deployer.address), 18));
  console.log("Vault Balance:", ethers.formatUnits(await vault.getVaultBalance(), 18));

  // Simulate Relayer: Bridge In on Secondary
  console.log(`Bridging in ${ethers.formatUnits(bridgeAmount, 18)} LIB to Secondary...`);
  // LiberdusSecondary bridgeIn(to, amount, chainId, txId, sourceChainId)
  // or bridgeIn(to, amount, chainId, txId) which defaults source to 0

  // We use the full signature for completeness if available, or just the standard one.
  // LiberdusSecondary has: bridgeIn(address,uint256,uint256,bytes32) and bridgeIn(address,uint256,uint256,bytes32,uint256)

  await liberdusSecondary
    .connect(deployer)
  ["bridgeIn(address,uint256,uint256,bytes32,uint256)"](
    deployer.address,
    bridgeAmount,
    CHAIN_ID_SECONDARY,
    ethers.id("tx1"),
    CHAIN_ID_PRIMARY
  );

  console.log("Secondary Balance:", ethers.formatUnits(await liberdusSecondary.balanceOf(deployer.address), 18));


  // ====================================================
  // 7. INTERACTION: BRIDGE BACK (Secondary -> Vault/Primary)
  // ====================================================
  console.log("\n--- Interaction: Bridge Back (Secondary -> Vault/Primary) ---");
  const returnAmount = ethers.parseUnits("200", 18);

  console.log(`Bridging out ${ethers.formatUnits(returnAmount, 18)} LIB from Secondary...`);
  // LiberdusSecondary bridgeOut(amount, target, chainId, destinationChainId)
  await liberdusSecondary
    .connect(deployer)
  ["bridgeOut(uint256,address,uint256,uint256)"](
    returnAmount,
    deployer.address,
    CHAIN_ID_SECONDARY,
    CHAIN_ID_PRIMARY
  );

  console.log("Secondary Balance:", ethers.formatUnits(await liberdusSecondary.balanceOf(deployer.address), 18));

  // Vault bridgeIn has been removed.
  console.log("Vault bridgeIn removed: skipping unlock simulation on primary.");
  console.log("Primary Balance:", ethers.formatUnits(await liberdus.balanceOf(deployer.address), 18));

  // ====================================================
  // 8. SWITCH PRIMARY TO POST-LAUNCH, THEN TEST PRIMARY BRIDGE
  // ====================================================
  console.log("\n--- Switching Primary to PostLaunch ---");
  await requestAndSignOperation(liberdus, 2, ZeroAddress, 0, "0x");

  console.log("\n--- Interaction: Test Primary bridgeOut + bridgeIn ---");
  const primaryBridgeAmount = ethers.parseUnits("50", 18);
  await liberdus
    .connect(deployer)
    .bridgeOut(primaryBridgeAmount, deployer.address, CHAIN_ID_PRIMARY);
  await liberdus
    .connect(deployer)
    .bridgeIn(deployer.address, primaryBridgeAmount, CHAIN_ID_PRIMARY, ethers.id("tx-primary-1"));
  console.log("Primary Balance After Primary Bridge Test:", ethers.formatUnits(await liberdus.balanceOf(deployer.address), 18));

  console.log("\n--- Deployment Summary ---");
  console.log(`LIBERDUS_TOKEN_ADDRESS=${await liberdus.getAddress()}`);
  console.log(`VAULT_ADDRESS=${await vault.getAddress()}`);
  console.log(`LIBERDUS_SECONDARY_ADDRESS=${await liberdusSecondary.getAddress()}`);
  console.log("\n--- DONE ---");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
