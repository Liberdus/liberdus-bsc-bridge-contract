const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Vault", function () {
  let Liberdus;
  let liberdus;
  let Vault;
  let vault;
  let owner, signer1, signer2, signer3, signer4, recipient, bridgeInCaller, other;
  let signers;
  let signerAddresses;
  let chainId;
  const destinationChainId = BigInt(97); // BSC testnet
  const sourceChainId = BigInt(97);

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
    [owner, signer1, signer2, signer3, signer4, recipient, bridgeInCaller, other] = await ethers.getSigners();
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

    it("Should initialize with no bridgeInCaller", async function () {
      expect(await vault.bridgeInCaller()).to.equal(ethers.ZeroAddress);
    });

    it("Should have correct chainId", async function () {
      expect(await vault.getChainId()).to.equal(chainId);
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
      const cooldownData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(60)]);
      await requestAndSignOperation(vault, 3, ethers.ZeroAddress, elevatedLimit, cooldownData);

      const tooMuch = ethers.parseUnits("200000", 18); // More than the 100k minted
      await liberdus.connect(owner).approve(await vault.getAddress(), tooMuch);

      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](tooMuch, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("Should reject bridging out more than maxBridgeInAmount", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      const reducedMaxAmount = ethers.parseUnits("500", 18);
      const cooldownData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(60)]);
      await requestAndSignOperation(vault, 3, ethers.ZeroAddress, reducedMaxAmount, cooldownData);

      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWith("Amount exceeds bridge-in limit");
    });

    it("Should reject bridging out when paused", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      // Pause vault
      await requestAndSignOperation(vault, 0, ethers.ZeroAddress, 0, "0x");

      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });
  });

  describe("Bridge In", function () {
    const bridgeAmount = ethers.parseUnits("5000", 18);

    beforeEach(async function () {
      await setupLiberdusWithTokens();
      // Bridge out tokens first to fund the vault
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);
      await vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId);
    });

    it("Should set bridge in caller before bridging in", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      expect(await vault.bridgeInCaller()).to.equal(owner.address);
    });

    it("Should bridge in tokens successfully", async function () {
      // Set bridgeInCaller first
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");

      const bridgeInAmount = ethers.parseUnits("1000", 18);
      const txId = ethers.id("test-tx-1");

      await expect(vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, txId, sourceChainId))
        .to.emit(vault, "BridgedIn");

      expect(await liberdus.balanceOf(recipient.address)).to.equal(bridgeInAmount);
      expect(await vault.getVaultBalance()).to.equal(bridgeAmount - bridgeInAmount);
    });

    it("Should reject bridge in from non-bridgeInCaller", async function () {
      const bridgeInAmount = ethers.parseUnits("1000", 18);
      const txId = ethers.id("test-tx-1");

      await expect(
        vault.connect(other)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Not authorized to bridge in");
    });

    it("Should reject bridging in zero tokens", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const txId = ethers.id("test-tx-1");

      await expect(
        vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, 0, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Cannot bridge in zero tokens");
    });

    it("Should reject bridging in to zero address", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const bridgeInAmount = ethers.parseUnits("1000", 18);
      const txId = ethers.id("test-tx-1");

      await expect(
        vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](ethers.ZeroAddress, bridgeInAmount, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Invalid recipient address");
    });

    it("Should reject bridging in more than maxBridgeInAmount", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const tooMuch = ethers.parseUnits("10001", 18);
      const txId = ethers.id("test-tx-1");

      await expect(
        vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, tooMuch, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Amount exceeds bridge-in limit");
    });

    it("Should enforce bridge in cooldown", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const bridgeInAmount = ethers.parseUnits("1000", 18);
      const txId1 = ethers.id("test-tx-1");
      const txId2 = ethers.id("test-tx-2");

      // First bridge in
      await vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, txId1, sourceChainId);

      // Immediate second bridge in should fail
      await expect(
        vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, txId2, sourceChainId)
      ).to.be.revertedWith("Bridge-in cooldown not met");

      // Wait for cooldown
      await network.provider.send("evm_increaseTime", [61]);
      await network.provider.send("evm_mine");

      // Should succeed after cooldown
      await vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, txId2, sourceChainId);
      expect(await liberdus.balanceOf(recipient.address)).to.equal(bridgeInAmount * BigInt(2));
    });

    it("Should prevent replay with same txId", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const bridgeInAmount = ethers.parseUnits("1000", 18);
      const txId = ethers.id("test-tx-1");

      // First bridge in
      await vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, txId, sourceChainId);

      // Wait for cooldown
      await network.provider.send("evm_increaseTime", [61]);
      await network.provider.send("evm_mine");

      // Same txId should fail
      await expect(
        vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Transaction already processed");
    });

    it("Should reject bridge in with insufficient vault balance", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const bridgeInAmount = ethers.parseUnits("6000", 18); // More than locked
      const txId = ethers.id("test-tx-1");

      await expect(
        vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Insufficient vault balance");
    });

    it("Should evict oldest txId after 100 bridge-ins", async function () {
      const highLimit = ethers.parseUnits("100000", 18);
      const lowCooldown = BigInt(1);
      const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [lowCooldown]);
      await requestAndSignOperation(vault, 3, ethers.ZeroAddress, highLimit, encodedData);

      // Fund vault with enough tokens
      const extraFunding = ethers.parseUnits("95000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), extraFunding);
      await vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](extraFunding, recipient.address, chainId, destinationChainId);

      // Set bridgeInCaller
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");

      const bridgeInAmount = ethers.parseUnits("1", 18);
      const txIds = [];

      // Do 101 bridge-ins
      for (let i = 0; i < 101; i++) {
        const txId = ethers.id(`eviction-test-tx-${i}`);
        txIds.push(txId);

        await network.provider.send("evm_increaseTime", [2]);
        await network.provider.send("evm_mine");

        await vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, txId, sourceChainId);
      }

      // The first txId (index 0) should have been evicted by the 101st bridgeIn
      expect(await vault.processedTxIds(txIds[0])).to.be.false;

      // The second txId (index 1) should still be processed
      expect(await vault.processedTxIds(txIds[1])).to.be.true;

      // The last txId should still be processed
      expect(await vault.processedTxIds(txIds[100])).to.be.true;
    });

    it("Should allow bridge in when paused", async function () {
      // Set bridgeInCaller first
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");

      // Pause vault
      await requestAndSignOperation(vault, 0, ethers.ZeroAddress, 0, "0x");

      const bridgeInAmount = ethers.parseUnits("1000", 18);
      const txId = ethers.id("test-tx-1");

      // Bridge in should still work when paused
      await vault.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, txId, sourceChainId);
      expect(await liberdus.balanceOf(recipient.address)).to.equal(bridgeInAmount);
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
      await requestAndSignOperation(vault, 5, ethers.ZeroAddress, 0, "0x");

      expect(await vault.getVaultBalance()).to.equal(0);
      expect(await liberdus.balanceOf(liberdusAddress)).to.equal(liberdusBalanceBefore + bridgeAmount);
    });

    it("Should emit TokensRelinquished event", async function () {
      const tx = await vault.requestOperation(5, ethers.ZeroAddress, 0, "0x");
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
      await requestAndSignOperation(vault, 0, ethers.ZeroAddress, 0, "0x");

      // RelinquishTokens should still work
      await requestAndSignOperation(vault, 5, ethers.ZeroAddress, 0, "0x");

      expect(await vault.getVaultBalance()).to.equal(0);
    });

    it("Should reject relinquish when vault has no tokens", async function () {
      // First relinquish all tokens
      await requestAndSignOperation(vault, 5, ethers.ZeroAddress, 0, "0x");

      // Second relinquish should fail
      await expect(
        requestAndSignOperation(vault, 5, ethers.ZeroAddress, 0, "0x")
      ).to.be.revertedWith("No tokens to relinquish");
    });
  });

  describe("Multi-sig Operations", function () {
    it("Should set bridge in caller via multisig", async function () {
      await requestAndSignOperation(vault, 2, bridgeInCaller.address, 0, "0x");
      expect(await vault.bridgeInCaller()).to.equal(bridgeInCaller.address);
    });

    it("Should set bridge in limits via multisig", async function () {
      const newMaxAmount = ethers.parseUnits("20000", 18);
      const newCooldown = BigInt(2 * 60);
      const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [newCooldown]);

      await requestAndSignOperation(vault, 3, ethers.ZeroAddress, newMaxAmount, encodedData);
      expect(await vault.maxBridgeInAmount()).to.equal(newMaxAmount);
      expect(await vault.bridgeInCooldown()).to.equal(newCooldown);
    });

    it("Should pause and unpause via multisig", async function () {
      await setupLiberdusWithTokens();
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      // Pause
      await requestAndSignOperation(vault, 0, ethers.ZeroAddress, 0, "0x");
      await expect(
        vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");

      // Unpause
      await requestAndSignOperation(vault, 1, ethers.ZeroAddress, 0, "0x");
      await vault.connect(owner)["bridgeOut(uint256,address,uint256,uint256)"](bridgeAmount, recipient.address, chainId, destinationChainId);
      expect(await vault.getVaultBalance()).to.equal(bridgeAmount);
    });

    it("Should update signer correctly", async function () {
      const newSigner = signer4;
      const oldSigner = signer3;

      const tx = await vault.requestOperation(4, oldSigner.address, BigInt(newSigner.address), "0x");
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
      const tx = await vault.requestOperation(2, bridgeInCaller.address, 0, "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Only 2 signatures
      for (let i = 0; i < 2; i++) {
        const messageHash = await vault.getOperationHash(operationId);
        const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
        await vault.connect(signers[i]).submitSignature(operationId, signature);
      }
      expect(await vault.bridgeInCaller()).to.not.equal(bridgeInCaller.address);

      // Third signature executes
      const messageHash = await vault.getOperationHash(operationId);
      const signature = await signers[2].signMessage(ethers.getBytes(messageHash));
      await vault.connect(signers[2]).submitSignature(operationId, signature);
      expect(await vault.bridgeInCaller()).to.equal(bridgeInCaller.address);
    });

    it("Should enforce 3-day operation deadline", async function () {
      const tx = await vault.requestOperation(2, bridgeInCaller.address, 0, "0x");
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
      const tx = await vault.requestOperation(2, bridgeInCaller.address, 0, "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      expect(await vault.isOperationExpired(operationId)).to.be.false;

      await network.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await network.provider.send("evm_mine");

      expect(await vault.isOperationExpired(operationId)).to.be.true;
    });
  });
});
