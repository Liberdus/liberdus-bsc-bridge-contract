# liberdus-bsc-bridge-contract

Vault contract for bridging Liberdus tokens from Polygon to BSC, used only before Liberdus mainnet launch.

## Overview

This repository contains the **Vault** contract — a multi-signature token vault that facilitates bridging Liberdus (LIB) tokens from Polygon to BSC prior to the Liberdus network mainnet launch.

The broader Liberdus bridge architecture uses three separate contracts:

| Repo | Role |
|---|---|
| `liberdus-token-contract` | Primary — main Liberdus ERC20 contract |
| `liberdus-bridge-contract` | Secondary — bridging between EVM chains (excl. Polygon POS) and Liberdus network |
| `liberdus-bsc-bridge-contract` | **Vault** — bridging from Polygon to BSC (pre-mainnet only) |

## How It Works

Users deposit LIB tokens into the Vault on Polygon by calling `bridgeOut`. The Vault holds the tokens and emits a `BridgedOut` event. A trusted relayer monitors these events and mints equivalent tokens on BSC via the secondary contract.

The Vault is governed by a 4-signer multi-sig scheme (3-of-4 required for execution) for all administrative operations. Once the Liberdus mainnet is live, the Vault can be permanently halted via the `RelinquishTokens` operation, which transfers all held tokens back to the token contract and disables further bridge-outs.

## Contract: Vault.sol

### State Variables

| Variable | Description |
|---|---|
| `token` | The ERC20 token (LIB) this vault manages |
| `signers[4]` | The four authorized multi-sig signers |
| `maxBridgeOutAmount` | Per-transaction bridge-out limit (default: 10,000 LIB) |
| `bridgeOutEnabled` | Whether bridge-out is currently active |
| `halted` | Permanently halted flag (set by `RelinquishTokens`) |
| `chainId` | The chain ID this vault is deployed on |

### Operations (Multi-Sig)

All administrative operations require 3-of-4 signer approval and must be executed within 3 days of being requested.

| Operation | Description |
|---|---|
| `SetBridgeOutAmount` | Update the per-transaction bridge-out limit |
| `UpdateSigner` | Replace one signer with a new address |
| `SetBridgeOutEnabled` | Enable or disable bridge-out |
| `RelinquishTokens` | Transfer all vault tokens back to the token contract and permanently halt the vault |

### User-Facing Functions

- **`bridgeOut(amount, targetAddress, chainId)`** — Deposit LIB tokens into the vault to initiate a bridge to BSC. Emits `BridgedOut`.

### Multi-Sig Workflow

1. A signer (or owner) calls `requestOperation(opType, target, value, data)` → returns `operationId`
2. Three signers each call `submitSignature(operationId, signature)` with an EIP-191 signature over the operation hash
3. On the third signature, the operation is automatically executed

## Setup

### Prerequisites

- Node.js >= 18
- npm

### Install

```bash
npm install
```

### Environment Variables

Create a `.env` file:

```env
# Deployment
PRIVATE_KEY=0x...                 # Deployer private key
LIBERDUS_TOKEN_ADDRESS=0x...      # Deployed LIB token address

# Signers (for production networks)
SIGNER_1=0x...
SIGNER_2=0x...
SIGNER_3=0x...
SIGNER_4=0x...

# RPC URLs
POLYGON_URL=https://polygon-rpc.com
BSC_TESTNET_URL=https://bsc-testnet-dataseed.bnbchain.org

# Block explorer API keys
POLYGONSCAN_API_KEY=...
BSCSCAN_API_KEY=...

# For interact-vault.js
VAULT_ADDRESS=0x...
ACTION=balance
```

## Deployment

Deploy the Vault contract (requires `LIBERDUS_TOKEN_ADDRESS` and signers configured for the target network):

```bash
# Deploy to Polygon
npx hardhat run scripts/deploy-vault.js --network polygon

# Deploy to BSC Testnet
npx hardhat run scripts/deploy-vault.js --network bscTestnet
```

## Interaction

Use `interact-vault.js` to perform vault operations locally or on a live network. Set the `ACTION` environment variable to one of the supported actions below.

### Check Balance & Status

```bash
ACTION=balance VAULT_ADDRESS=0x... npx hardhat run scripts/interact-vault.js --network localhost
```

### Bridge Out

```bash
ACTION=bridgeOut \
  VAULT_ADDRESS=0x... \
  LIBERDUS_TOKEN_ADDRESS=0x... \
  AMOUNT=100 \
  TARGET_ADDRESS=0x... \
  npx hardhat run scripts/interact-vault.js --network localhost
```

### Set Bridge Out Amount

```bash
ACTION=setBridgeOutAmount \
  VAULT_ADDRESS=0x... \
  MAX_BRIDGE_OUT_AMOUNT=5000 \
  npx hardhat run scripts/interact-vault.js --network localhost
```

### Enable / Disable Bridge Out

```bash
ACTION=setBridgeOutEnabled \
  VAULT_ADDRESS=0x... \
  BRIDGE_OUT_ENABLED=false \
  npx hardhat run scripts/interact-vault.js --network localhost
```

### Relinquish (Permanent Halt)

```bash
ACTION=relinquish \
  VAULT_ADDRESS=0x... \
  npx hardhat run scripts/interact-vault.js --network localhost
```

## Testing

```bash
npx hardhat test test/vault.test.js
```

## Networks

| Network | Chain ID | Purpose |
|---|---|---|
| Polygon | 137 | Mainnet deployment (source chain) |
| Amoy | 80002 | Polygon testnet |
| BSC Testnet | 97 | BSC testnet |
| Localhost | 31337 | Local development |

## License

MIT
