// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract BridgeVault is Pausable, ReentrancyGuard, Ownable {
    using ECDSA for bytes32;

    enum OperationType {
        Pause,
        Unpause,
        SetReleaseCaller,
        SetReleaseLimits,
        UpdateSigner
    }

    struct Operation {
        OperationType opType;
        address target;
        uint256 value;
        bytes data;
        uint256 numSignatures;
        bool executed;
        uint256 deadline;
        mapping(address => bool) signatures;
    }

    mapping(bytes32 => Operation) public operations;
    uint256 public operationCount;

    uint256 public constant OPERATION_DEADLINE = 3 days;

    IERC20 public immutable token;
    address public releaseCaller;
    uint256 public maxReleaseAmount = 10_000 * 10**18;
    uint256 public releaseCooldown = 1 minutes;
    uint256 public lastReleaseTime;

    mapping(bytes32 => bool) public processedTxIds;

    address[4] public signers;
    uint256 public constant REQUIRED_SIGNATURES = 3;
    uint256 public constant DEFAULT_CHAIN_ID = 0;
    uint256 public immutable chainId;

    // Events
    event OperationRequested(
        bytes32 indexed operationId,
        OperationType indexed opType,
        address indexed requester,
        address target,
        uint256 value,
        bytes data,
        uint256 deadline,
        uint256 timestamp
    );

    event SignatureSubmitted(
        bytes32 indexed operationId,
        address indexed signer,
        uint256 currentSignatures,
        uint256 requiredSignatures,
        uint256 timestamp
    );

    event OperationExecuted(
        bytes32 indexed operationId,
        OperationType indexed opType
    );

    event ReleaseCallerUpdated(
        bytes32 indexed operationId,
        address indexed newCaller,
        uint256 timestamp
    );

    event ReleaseLimitsUpdated(
        bytes32 indexed operationId,
        uint256 newMaxAmount,
        uint256 newCooldown,
        uint256 timestamp
    );

    event SignerUpdated(
        bytes32 indexed operationId,
        address indexed oldSigner,
        address indexed newSigner,
        uint256 timestamp
    );

    event TokensLocked(
        address indexed from,
        uint256 amount,
        address indexed targetAddress,
        uint256 indexed chainId,
        uint256 timestamp,
        uint256 destinationChainId
    );

    event TokensReleased(
        address indexed to,
        uint256 amount,
        uint256 indexed chainId,
        bytes32 indexed txId,
        uint256 timestamp,
        uint256 sourceChainId
    );

    modifier onlySigner() {
        require(isSigner(msg.sender), "Not a signer");
        _;
    }

    modifier onlyReleaseCaller() {
        require(msg.sender == releaseCaller, "Not authorized to release");
        _;
    }

    constructor(address _token, address[4] memory _signers, uint256 _chainId) Ownable(msg.sender) {
        require(_token != address(0), "Invalid token address");

        for (uint i = 0; i < _signers.length; i++) {
            require(_signers[i] != address(0), "Invalid signer address");
            for (uint j = 0; j < i; j++) {
                require(_signers[i] != _signers[j], "Duplicate signer address");
            }
        }

        token = IERC20(_token);
        signers = _signers;
        chainId = _chainId;

        // [TOD0] Remove these lines before deploying to production
        // releaseCaller = _signers[0]; // For development purposes
    }

    // --------- MULTI-SIG OPERATIONS ---------

    function requestOperation(
        OperationType opType,
        address target,
        uint256 value,
        bytes memory data
    ) public returns (bytes32) {
        require(isSigner(msg.sender) || owner() == msg.sender, "Not authorized to request operation");

        if (opType == OperationType.UpdateSigner) {
            address oldSigner = target;
            address newSigner = address(uint160(value));
            require(isSigner(oldSigner), "Old signer not found");
            require(!isSigner(newSigner), "New signer already exists");
            require(oldSigner != msg.sender, "Cannot request to replace self");
        }

        uint256 deadline = block.timestamp + OPERATION_DEADLINE;
        bytes32 operationId = keccak256(abi.encodePacked(operationCount++, opType, target, value, data, chainId));
        Operation storage op = operations[operationId];
        op.opType = opType;
        op.target = target;
        op.value = value;
        op.data = data;
        op.executed = false;
        op.numSignatures = 0;
        op.deadline = deadline;

        emit OperationRequested(
            operationId,
            opType,
            msg.sender,
            target,
            value,
            data,
            deadline,
            block.timestamp
        );
        return operationId;
    }

    function submitSignature(bytes32 operationId, bytes memory signature) public {
        require(isSigner(msg.sender), "Only signers can submit signatures");
        Operation storage op = operations[operationId];
        require(!op.executed, "Operation already executed");
        require(!op.signatures[msg.sender], "Signature already submitted");
        require(block.timestamp <= op.deadline, "Operation deadline passed");

        bytes32 messageHash = getOperationHash(operationId);
        bytes32 prefixedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        address signer = ECDSA.recover(prefixedHash, signature);

        require(signer == msg.sender, "Signature signer must be message sender");

        if (op.opType == OperationType.UpdateSigner) {
            require(isSigner(signer) || signer == owner(), "Invalid signature for UpdateSigner");
            require(signer != op.target, "Signer being replaced cannot approve");
        } else {
            require(isSigner(signer), "Invalid signature");
        }

        require(op.numSignatures < REQUIRED_SIGNATURES, "Enough signatures already");

        op.signatures[signer] = true;
        op.numSignatures++;

        emit SignatureSubmitted(operationId, signer, op.numSignatures, REQUIRED_SIGNATURES, block.timestamp);

        if (op.numSignatures == REQUIRED_SIGNATURES) {
            executeOperation(operationId);
        }
    }

    function executeOperation(bytes32 operationId) internal nonReentrant {
        Operation storage op = operations[operationId];
        require(!op.executed, "Operation already executed");

        op.executed = true;

        if (op.opType == OperationType.UpdateSigner) {
            _executeUpdateSigner(operationId, op.target, address(uint160(op.value)));
        } else if (op.opType == OperationType.Pause) {
            _pause();
        } else if (op.opType == OperationType.Unpause) {
            _unpause();
        } else if (op.opType == OperationType.SetReleaseCaller) {
            _executeSetReleaseCaller(operationId, op.target);
        } else if (op.opType == OperationType.SetReleaseLimits) {
            _executeSetReleaseLimits(operationId, op.value, abi.decode(op.data, (uint256)));
        } else {
            revert("Unknown operation type");
        }

        emit OperationExecuted(operationId, op.opType);
    }

    function _executeSetReleaseCaller(bytes32 operationId, address newCaller) internal {
        require(newCaller != address(0), "Invalid release caller");
        require(newCaller != releaseCaller, "Release caller already set");
        releaseCaller = newCaller;
        emit ReleaseCallerUpdated(operationId, newCaller, block.timestamp);
    }

    function _executeSetReleaseLimits(bytes32 operationId, uint256 newMaxAmount, uint256 newCooldown) internal {
        require(newMaxAmount > 0, "Max amount must be greater than zero");
        require(newCooldown > 0, "Cooldown must be greater than zero");
        maxReleaseAmount = newMaxAmount;
        releaseCooldown = newCooldown;
        emit ReleaseLimitsUpdated(operationId, newMaxAmount, newCooldown, block.timestamp);
    }

    function _executeUpdateSigner(bytes32 operationId, address oldSigner, address newSigner) internal {
        require(isSigner(oldSigner), "Old signer not found");
        require(!isSigner(newSigner), "New signer already exists");

        for (uint i = 0; i < signers.length; i++) {
            if (signers[i] == oldSigner) {
                signers[i] = newSigner;
                break;
            }
        }
        emit SignerUpdated(operationId, oldSigner, newSigner, block.timestamp);
    }

    // --------- LOCK & RELEASE ---------

    function lockTokens(uint256 amount, address targetAddress, uint256 _chainId) public whenNotPaused {
        lockTokens(amount, targetAddress, _chainId, DEFAULT_CHAIN_ID);
    }

    function lockTokens(uint256 amount, address targetAddress, uint256 _chainId, uint256 destinationChainId) public whenNotPaused {
        require(amount > 0, "Cannot lock zero tokens");
        require(targetAddress != address(0), "Invalid target address");
        require(_chainId == chainId, "Invalid chain ID");
        if (destinationChainId != DEFAULT_CHAIN_ID) {
            require(destinationChainId != _chainId, "Destination chain must differ from source chain");
        }

        require(token.transferFrom(msg.sender, address(this), amount), "Token transfer failed");

        emit TokensLocked(msg.sender, amount, targetAddress, _chainId, block.timestamp, destinationChainId);
    }

    function releaseTokens(address to, uint256 amount, uint256 _chainId, bytes32 txId) public onlyReleaseCaller whenNotPaused {
        releaseTokens(to, amount, _chainId, txId, DEFAULT_CHAIN_ID);
    }

    function releaseTokens(address to, uint256 amount, uint256 _chainId, bytes32 txId, uint256 sourceChainId) public onlyReleaseCaller whenNotPaused nonReentrant {
        require(amount > 0, "Cannot release zero tokens");
        require(to != address(0), "Invalid recipient address");
        require(_chainId == chainId, "Invalid chain ID");
        require(amount <= maxReleaseAmount, "Amount exceeds release limit");
        require(block.timestamp >= lastReleaseTime + releaseCooldown, "Release cooldown not met");
        require(!processedTxIds[txId], "Transaction already processed");

        require(token.balanceOf(address(this)) >= amount, "Insufficient vault balance");

        processedTxIds[txId] = true;
        lastReleaseTime = block.timestamp;

        require(token.transfer(to, amount), "Token transfer failed");

        emit TokensReleased(to, amount, _chainId, txId, block.timestamp, sourceChainId);
    }

    // --------- HELPER FUNCTIONS ---------

    function isSigner(address account) public view returns (bool) {
        for (uint i = 0; i < signers.length; i++) {
            if (signers[i] == account) {
                return true;
            }
        }
        return false;
    }

    function getOperationHash(bytes32 operationId) public view returns (bytes32) {
        Operation storage op = operations[operationId];
        return keccak256(abi.encodePacked(operationId, op.opType, op.target, op.value, op.data, chainId));
    }

    function getChainId() public view returns (uint256) {
        return chainId;
    }

    function isOperationExpired(bytes32 operationId) public view returns (bool) {
        return block.timestamp > operations[operationId].deadline;
    }

    function getVaultBalance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
