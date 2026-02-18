const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Vault", function () {
  let Liberdus;
  let liberdus;
  let Vault;
  let vault;
  let owner, signer1, signer2, signer3, signer4, recipient, other;
  let signers;
  let signerAddresses;
  let chainId;
  const destinationChainId = BigInt(97); // BSC testnet
  const OP = Object.freeze({
    PAUSE: 0,
    UNPAUSE: 1,
    SET_BRIDGE_OUT_AMOUNT: 2,
    UPDATE_SIGNER: 3,
    RELINQUISH_TOKENS: 4,
    SET_BRIDGE_OUT_ENABLED: 5,
  });

  async function requestAndSignOperation(contract, operationType, target, value, data) {
    const tx = await contract.requestOperation(operationType, target, value, data);
    const receipt = await tx.wait();

    const operationRequestedEvent = receipt.logs.find(log => log.fragment.name === 'OperationRequested');
    const operationId = operationRequestedEvent.args.operationId;

    for (let i = 0; i < 3; i++) {
      const messageHash = await contract.getOperationHash(operationId);
      const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
      await contract.connect(signers[i]).submitSignature(operationId, signature);
    }

    return operationId;
  }

  async function setupLiberdusWithTokens() {
    // Mint tokens via multisig (OpType 0 = Mint)
    await requestAndSignOperation(liberdus, 0, owner.address, 0, "0x");

    // Distribute tokens to owner (OpType 8 = DistributeTokens)
    const distributionAmount = ethers.parseUnits("100000", 18);
    await requestAndSignOperation(liberdus, 8, owner.address, distributionAmount, "0x");

    return distributionAmount;
  }

  beforeEach(async function () {
    [owner, signer1, signer2, signer3, signer4, recipient, other] = await ethers.getSigners();
    signers = [owner, signer1, signer2, signer3];
    signerAddresses = [owner.address, signer1.address, signer2.address, signer3.address];
    chainId = BigInt((await ethers.provider.getNetwork()).chainId);

    // Deploy Liberdus (primary token)
    Liberdus = await ethers.getContractFactory("Liberdus");
    liberdus = await Liberdus.deploy(signerAddresses, chainId);
    await liberdus.waitForDeployment();

    // Deploy Vault
    Vault = await ethers.getContractFactory("Vault");
    vault = await Vault.deploy(await liberdus.getAddress(), signerAddresses, chainId);
    await vault.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should deploy with correct token address", async function () {
      expect(await vault.token()).to.equal(await liberdus.getAddress());
    });

    it("Should deploy with correct signers", async function () {
      for (let i = 0; i < 4; i++) {
        expect(await vault.isSigner(signerAddresses[i])).to.be.true;
      }
    });

    it("Should have correct chainId", async function () {
      expect(await vault.getChainId()).to.equal(chainId);
    });

    it("Should initialize with bridgeOut enabled", async function () {
      expect(await vault.bridgeOutEnabled()).to.equal(true);
    });

    it("Should reject zero token address", async function () {
      await expect(
        Vault.deploy(ethers.ZeroAddress, signerAddresses, chainId)
      ).to.be.revertedWith("Invalid token address");
    });
  });

  describe("Bridge Out", function () {
    beforeEach(async function () {
      await setupLiberdusWithTokens();
    });

    it("Should bridge out tokens successfully", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);

      // Approve vault
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      // Bridge out tokens and check event
      await expect(vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId))
        .to.emit(vault, "BridgedOut");

      expect(await vault.getVaultBalance()).to.equal(bridgeAmount);
      expect(await liberdus.balanceOf(owner.address)).to.equal(ethers.parseUnits("99000", 18));
    });

    it("Should reject bridging out zero tokens", async function () {
      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](0, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWith("Cannot bridge out zero tokens");
    });

    it("Should reject bridging out to zero address", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, ethers.ZeroAddress, chainId, destinationChainId)
      ).to.be.revertedWith("Invalid target address");
    });

    it("Should reject bridging out without approval", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId)
      ).to.be.reverted;
    });

    it("Should reject bridging out with insufficient balance", async function () {
      const elevatedLimit = ethers.parseUnits("300000", 18);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, elevatedLimit, "0x");

      const tooMuch = ethers.parseUnits("200000", 18); // More than the 100k minted
      await liberdus.connect(owner).approve(await vault.getAddress(), tooMuch);

      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](tooMuch, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("Should reject bridging out more than maxBridgeOutAmount", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      const reducedMaxAmount = ethers.parseUnits("500", 18);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, reducedMaxAmount, "0x");

      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWith("Amount exceeds bridge-out limit");
    });

    it("Should reject bridging out when paused", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      // Pause vault
      await requestAndSignOperation(vault, OP.PAUSE, ethers.ZeroAddress, 0, "0x");

      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });

    it("Should reject bridging out when bridgeOut is disabled", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      const disabledData = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [false]);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_ENABLED, ethers.ZeroAddress, 0, disabledData);

      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWith("Bridge-out disabled");
    });

    it("Should disable and then re-enable bridgeOut via multisig", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      const disabledData = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [false]);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_ENABLED, ethers.ZeroAddress, 0, disabledData);
      expect(await vault.bridgeOutEnabled()).to.equal(false);

      const enabledData = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_ENABLED, ethers.ZeroAddress, 0, enabledData);
      expect(await vault.bridgeOutEnabled()).to.equal(true);

      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId)
      ).to.emit(vault, "BridgedOut");
    });
  });

  describe("Relinquish Tokens", function () {
    const bridgeAmount = ethers.parseUnits("5000", 18);

    beforeEach(async function () {
      await setupLiberdusWithTokens();
      // Bridge out tokens first to fund the vault
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);
      await vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId);
    });

    it("Should relinquish all tokens to Liberdus contract via multisig", async function () {
      const vaultBalanceBefore = await vault.getVaultBalance();
      expect(vaultBalanceBefore).to.equal(bridgeAmount);

      const liberdusAddress = await liberdus.getAddress();
      const liberdusBalanceBefore = await liberdus.balanceOf(liberdusAddress);

      // RelinquishTokens is OperationType 5
      await requestAndSignOperation(vault, OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x");

      expect(await vault.getVaultBalance()).to.equal(0);
      expect(await liberdus.balanceOf(liberdusAddress)).to.equal(liberdusBalanceBefore + bridgeAmount);
    });

    it("Should emit TokensRelinquished event", async function () {
      const tx = await vault.requestOperation(OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Sign with first 2 signers
      for (let i = 0; i < 2; i++) {
        const messageHash = await vault.getOperationHash(operationId);
        const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
        await vault.connect(signers[i]).submitSignature(operationId, signature);
      }

      // Third signature triggers execution
      const messageHash = await vault.getOperationHash(operationId);
      const signature = await signers[2].signMessage(ethers.getBytes(messageHash));
      await expect(vault.connect(signers[2]).submitSignature(operationId, signature))
        .to.emit(vault, "TokensRelinquished");
    });

    it("Should relinquish tokens even when paused", async function () {
      // Pause vault
      await requestAndSignOperation(vault, OP.PAUSE, ethers.ZeroAddress, 0, "0x");

      // RelinquishTokens should still work
      await requestAndSignOperation(vault, OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x");

      expect(await vault.getVaultBalance()).to.equal(0);
    });

    it("Should reject relinquish when vault has no tokens", async function () {
      // First relinquish all tokens
      await requestAndSignOperation(vault, OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x");

      // Second relinquish should fail
      await expect(
        requestAndSignOperation(vault, OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x")
      ).to.be.revertedWith("No tokens to relinquish");
    });
  });

  describe("Multi-sig Operations", function () {
    it("Should set bridge out amount via multisig", async function () {
      const newMaxAmount = ethers.parseUnits("20000", 18);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, newMaxAmount, "0x");
      expect(await vault.maxBridgeOutAmount()).to.equal(newMaxAmount);
    });

    it("Should pause and unpause via multisig", async function () {
      await setupLiberdusWithTokens();
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      // Pause
      await requestAndSignOperation(vault, OP.PAUSE, ethers.ZeroAddress, 0, "0x");
      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");

      // Unpause
      await requestAndSignOperation(vault, OP.UNPAUSE, ethers.ZeroAddress, 0, "0x");
      await vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId);
      expect(await vault.getVaultBalance()).to.equal(bridgeAmount);
    });

    it("Should update signer correctly", async function () {
      const newSigner = signer4;
      const oldSigner = signer3;

      const tx = await vault.requestOperation(OP.UPDATE_SIGNER, oldSigner.address, BigInt(newSigner.address), "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Sign with 3 signers (not the one being replaced)
      const signersToSign = signers.filter(s => s !== oldSigner).slice(0, 3);
      for (const signer of signersToSign) {
        const messageHash = await vault.getOperationHash(operationId);
        const signature = await signer.signMessage(ethers.getBytes(messageHash));
        await vault.connect(signer).submitSignature(operationId, signature);
      }

      expect(await vault.isSigner(newSigner.address)).to.be.true;
      expect(await vault.isSigner(oldSigner.address)).to.be.false;
    });

    it("Should require three signatures", async function () {
      const newMaxAmount = ethers.parseUnits("25000", 18);
      const tx = await vault.requestOperation(OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, newMaxAmount, "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Only 2 signatures
      for (let i = 0; i < 2; i++) {
        const messageHash = await vault.getOperationHash(operationId);
        const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
        await vault.connect(signers[i]).submitSignature(operationId, signature);
      }
      expect(await vault.maxBridgeOutAmount()).to.not.equal(newMaxAmount);

      // Third signature executes
      const messageHash = await vault.getOperationHash(operationId);
      const signature = await signers[2].signMessage(ethers.getBytes(messageHash));
      await vault.connect(signers[2]).submitSignature(operationId, signature);
      expect(await vault.maxBridgeOutAmount()).to.equal(newMaxAmount);
    });

    it("Should enforce 3-day operation deadline", async function () {
      const tx = await vault.requestOperation(OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, ethers.parseUnits("20000", 18), "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Fast forward 3 days + 1 second
      await network.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await network.provider.send("evm_mine");

      const messageHash = await vault.getOperationHash(operationId);
      const signature = await signers[0].signMessage(ethers.getBytes(messageHash));
      await expect(
        vault.connect(signers[0]).submitSignature(operationId, signature)
      ).to.be.revertedWith("Operation deadline passed");
    });

    it("Should revert no-op bridgeOut status update", async function () {
      const enabledData = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
      await expect(
        requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_ENABLED, ethers.ZeroAddress, 0, enabledData)
      ).to.be.revertedWith("Bridge-out status already set");
    });
  });

  describe("Helper Functions", function () {
    it("Should return correct vault balance", async function () {
      await setupLiberdusWithTokens();
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);
      await vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId);

      expect(await vault.getVaultBalance()).to.equal(bridgeAmount);
    });

    it("Should check operation expiry correctly", async function () {
      const tx = await vault.requestOperation(OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, ethers.parseUnits("30000", 18), "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      expect(await vault.isOperationExpired(operationId)).to.be.false;

      await network.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await network.provider.send("evm_mine");

      expect(await vault.isOperationExpired(operationId)).to.be.true;
    });
  });
});
