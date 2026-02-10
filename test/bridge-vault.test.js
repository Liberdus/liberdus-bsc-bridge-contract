const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BridgeVault", function () {
  let Liberdus;
  let liberdus;
  let BridgeVault;
  let vault;
  let owner, signer1, signer2, signer3, signer4, recipient, releaseCaller, other;
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
    [owner, signer1, signer2, signer3, signer4, recipient, releaseCaller, other] = await ethers.getSigners();
    signers = [owner, signer1, signer2, signer3];
    signerAddresses = [owner.address, signer1.address, signer2.address, signer3.address];
    chainId = BigInt((await ethers.provider.getNetwork()).chainId);

    // Deploy Liberdus (primary token)
    Liberdus = await ethers.getContractFactory("Liberdus");
    liberdus = await Liberdus.deploy(signerAddresses, chainId);
    await liberdus.waitForDeployment();

    // Deploy BridgeVault
    BridgeVault = await ethers.getContractFactory("BridgeVault");
    vault = await BridgeVault.deploy(await liberdus.getAddress(), signerAddresses, chainId);
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

    it("Should initialize with no releaseCaller", async function () {
      expect(await vault.releaseCaller()).to.equal(ethers.ZeroAddress);
    });

    it("Should have correct chainId", async function () {
      expect(await vault.getChainId()).to.equal(chainId);
    });

    it("Should reject zero token address", async function () {
      await expect(
        BridgeVault.deploy(ethers.ZeroAddress, signerAddresses, chainId)
      ).to.be.revertedWith("Invalid token address");
    });
  });

  describe("Lock Tokens", function () {
    beforeEach(async function () {
      await setupLiberdusWithTokens();
    });

    it("Should lock tokens successfully", async function () {
      const lockAmount = ethers.parseUnits("1000", 18);

      // Approve vault
      await liberdus.connect(owner).approve(await vault.getAddress(), lockAmount);

      // Lock tokens and check event (without exact timestamp match)
      await expect(vault.connect(owner)["lockTokens(uint256,address,uint256,uint256)"](lockAmount, recipient.address, chainId, destinationChainId))
        .to.emit(vault, "TokensLocked");

      expect(await vault.getVaultBalance()).to.equal(lockAmount);
      expect(await liberdus.balanceOf(owner.address)).to.equal(ethers.parseUnits("99000", 18));
    });

    it("Should reject locking zero tokens", async function () {
      await expect(
        vault.connect(owner)["lockTokens(uint256,address,uint256,uint256)"](0, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWith("Cannot lock zero tokens");
    });

    it("Should reject locking to zero address", async function () {
      const lockAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), lockAmount);

      await expect(
        vault.connect(owner)["lockTokens(uint256,address,uint256,uint256)"](lockAmount, ethers.ZeroAddress, chainId, destinationChainId)
      ).to.be.revertedWith("Invalid target address");
    });

    it("Should reject locking without approval", async function () {
      const lockAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault.connect(owner)["lockTokens(uint256,address,uint256,uint256)"](lockAmount, recipient.address, chainId, destinationChainId)
      ).to.be.reverted;
    });

    it("Should reject locking when paused", async function () {
      const lockAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), lockAmount);

      // Pause vault
      await requestAndSignOperation(vault, 0, ethers.ZeroAddress, 0, "0x");

      await expect(
        vault.connect(owner)["lockTokens(uint256,address,uint256,uint256)"](lockAmount, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });
  });

  describe("Release Tokens", function () {
    const lockAmount = ethers.parseUnits("5000", 18);

    beforeEach(async function () {
      await setupLiberdusWithTokens();
      // Lock tokens first
      await liberdus.connect(owner).approve(await vault.getAddress(), lockAmount);
      await vault.connect(owner)["lockTokens(uint256,address,uint256,uint256)"](lockAmount, recipient.address, chainId, destinationChainId);
    });

    it("Should set release caller before releasing", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      expect(await vault.releaseCaller()).to.equal(owner.address);
    });

    it("Should release tokens successfully", async function () {
      // Set releaseCaller first
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");

      const releaseAmount = ethers.parseUnits("1000", 18);
      const txId = ethers.id("test-tx-1");

      await expect(vault.connect(owner)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](recipient.address, releaseAmount, chainId, txId, sourceChainId))
        .to.emit(vault, "TokensReleased");

      expect(await liberdus.balanceOf(recipient.address)).to.equal(releaseAmount);
      expect(await vault.getVaultBalance()).to.equal(lockAmount - releaseAmount);
    });

    it("Should reject release from non-releaseCaller", async function () {
      const releaseAmount = ethers.parseUnits("1000", 18);
      const txId = ethers.id("test-tx-1");

      await expect(
        vault.connect(other)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](recipient.address, releaseAmount, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Not authorized to release");
    });

    it("Should reject releasing zero tokens", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const txId = ethers.id("test-tx-1");

      await expect(
        vault.connect(owner)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](recipient.address, 0, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Cannot release zero tokens");
    });

    it("Should reject releasing to zero address", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const releaseAmount = ethers.parseUnits("1000", 18);
      const txId = ethers.id("test-tx-1");

      await expect(
        vault.connect(owner)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](ethers.ZeroAddress, releaseAmount, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Invalid recipient address");
    });

    it("Should reject releasing more than maxReleaseAmount", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const tooMuch = ethers.parseUnits("10001", 18);
      const txId = ethers.id("test-tx-1");

      await expect(
        vault.connect(owner)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](recipient.address, tooMuch, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Amount exceeds release limit");
    });

    it("Should enforce release cooldown", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const releaseAmount = ethers.parseUnits("1000", 18);
      const txId1 = ethers.id("test-tx-1");
      const txId2 = ethers.id("test-tx-2");

      // First release
      await vault.connect(owner)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](recipient.address, releaseAmount, chainId, txId1, sourceChainId);

      // Immediate second release should fail
      await expect(
        vault.connect(owner)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](recipient.address, releaseAmount, chainId, txId2, sourceChainId)
      ).to.be.revertedWith("Release cooldown not met");

      // Wait for cooldown
      await network.provider.send("evm_increaseTime", [61]);
      await network.provider.send("evm_mine");

      // Should succeed after cooldown
      await vault.connect(owner)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](recipient.address, releaseAmount, chainId, txId2, sourceChainId);
      expect(await liberdus.balanceOf(recipient.address)).to.equal(releaseAmount * BigInt(2));
    });

    it("Should prevent replay with same txId", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const releaseAmount = ethers.parseUnits("1000", 18);
      const txId = ethers.id("test-tx-1");

      // First release
      await vault.connect(owner)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](recipient.address, releaseAmount, chainId, txId, sourceChainId);

      // Wait for cooldown
      await network.provider.send("evm_increaseTime", [61]);
      await network.provider.send("evm_mine");

      // Same txId should fail
      await expect(
        vault.connect(owner)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](recipient.address, releaseAmount, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Transaction already processed");
    });

    it("Should reject release with insufficient vault balance", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const releaseAmount = ethers.parseUnits("6000", 18); // More than locked
      const txId = ethers.id("test-tx-1");

      await expect(
        vault.connect(owner)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](recipient.address, releaseAmount, chainId, txId, sourceChainId)
      ).to.be.revertedWith("Insufficient vault balance");
    });

    it("Should reject release when paused", async function () {
      await requestAndSignOperation(vault, 2, owner.address, 0, "0x");
      const releaseAmount = ethers.parseUnits("1000", 18);
      const txId = ethers.id("test-tx-1");

      // Pause vault
      await requestAndSignOperation(vault, 0, ethers.ZeroAddress, 0, "0x");

      await expect(
        vault.connect(owner)["releaseTokens(address,uint256,uint256,bytes32,uint256)"](recipient.address, releaseAmount, chainId, txId, sourceChainId)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });
  });

  describe("Multi-sig Operations", function () {
    it("Should set release caller via multisig", async function () {
      await requestAndSignOperation(vault, 2, releaseCaller.address, 0, "0x");
      expect(await vault.releaseCaller()).to.equal(releaseCaller.address);
    });

    it("Should set release limits via multisig", async function () {
      const newMaxAmount = ethers.parseUnits("20000", 18);
      const newCooldown = BigInt(2 * 60);
      const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [newCooldown]);

      await requestAndSignOperation(vault, 3, ethers.ZeroAddress, newMaxAmount, encodedData);
      expect(await vault.maxReleaseAmount()).to.equal(newMaxAmount);
      expect(await vault.releaseCooldown()).to.equal(newCooldown);
    });

    it("Should pause and unpause via multisig", async function () {
      await setupLiberdusWithTokens();
      const lockAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), lockAmount);

      // Pause
      await requestAndSignOperation(vault, 0, ethers.ZeroAddress, 0, "0x");
      await expect(
        vault.connect(owner)["lockTokens(uint256,address,uint256,uint256)"](lockAmount, recipient.address, chainId, destinationChainId)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");

      // Unpause
      await requestAndSignOperation(vault, 1, ethers.ZeroAddress, 0, "0x");
      await vault.connect(owner)["lockTokens(uint256,address,uint256,uint256)"](lockAmount, recipient.address, chainId, destinationChainId);
      expect(await vault.getVaultBalance()).to.equal(lockAmount);
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
      const tx = await vault.requestOperation(2, releaseCaller.address, 0, "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Only 2 signatures
      for (let i = 0; i < 2; i++) {
        const messageHash = await vault.getOperationHash(operationId);
        const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
        await vault.connect(signers[i]).submitSignature(operationId, signature);
      }
      expect(await vault.releaseCaller()).to.not.equal(releaseCaller.address);

      // Third signature executes
      const messageHash = await vault.getOperationHash(operationId);
      const signature = await signers[2].signMessage(ethers.getBytes(messageHash));
      await vault.connect(signers[2]).submitSignature(operationId, signature);
      expect(await vault.releaseCaller()).to.equal(releaseCaller.address);
    });

    it("Should enforce 3-day operation deadline", async function () {
      const tx = await vault.requestOperation(2, releaseCaller.address, 0, "0x");
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
      const lockAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), lockAmount);
      await vault.connect(owner)["lockTokens(uint256,address,uint256,uint256)"](lockAmount, recipient.address, chainId, destinationChainId);

      expect(await vault.getVaultBalance()).to.equal(lockAmount);
    });

    it("Should check operation expiry correctly", async function () {
      const tx = await vault.requestOperation(2, releaseCaller.address, 0, "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      expect(await vault.isOperationExpired(operationId)).to.be.false;

      await network.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await network.provider.send("evm_mine");

      expect(await vault.isOperationExpired(operationId)).to.be.true;
    });
  });
});
