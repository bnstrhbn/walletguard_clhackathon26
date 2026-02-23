pragma solidity ^0.8.20;

interface IERC165 {
  function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
  function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IIntentRegistry {
  struct Intent {
    address creator;
    address vault;
    address to;
    uint256 value;
    bytes data;
    uint256 deadline;
    uint8 mode;
    uint8 status;
    bytes32 receiptHash;
    bytes32 executorTxHash;
  }

  function getIntent(uint256 intentId) external view returns (Intent memory);

  function markProcessing(uint256 intentId) external;

  function finalize(uint256 intentId, uint8 status, bytes32 receiptHash, bytes32 executorTxHash) external;
}

interface IWalletGuardVault {
  function execute(address to, uint256 value, bytes calldata data, bytes32 receiptHash) external;
}

contract WalletGuardWatcherReceiver is IReceiver {
  enum Mode {
    AUTO_EXECUTE,
    PROPOSE_ONLY
  }

  enum Status {
    NONE,
    SUBMITTED,
    PROCESSING,
    EXECUTED,
    REJECTED,
    EXPIRED,
    ERROR
  }

  address public owner;
  address public forwarder;

  bool public registryAllowlistEnabled;
  mapping(address => bool) public allowedRegistry;

  modifier onlyOwner() {
    require(msg.sender == owner, 'ONLY_OWNER');
    _;
  }

  constructor(address owner_, address forwarder_) {
    require(owner_ != address(0), 'OWNER_ZERO');
    require(forwarder_ != address(0), 'FORWARDER_ZERO');
    owner = owner_;
    forwarder = forwarder_;
  }

  function setOwner(address owner_) external onlyOwner {
    require(owner_ != address(0), 'OWNER_ZERO');
    owner = owner_;
  }

  function setForwarder(address forwarder_) external onlyOwner {
    require(forwarder_ != address(0), 'FORWARDER_ZERO');
    forwarder = forwarder_;
  }

  function setRegistryAllowlistEnabled(bool enabled) external onlyOwner {
    registryAllowlistEnabled = enabled;
  }

  function setAllowedRegistry(address registry, bool allowed) external onlyOwner {
    allowedRegistry[registry] = allowed;
  }

  function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
    return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }

  function onReport(bytes calldata, bytes calldata report) external {
    require(msg.sender == forwarder, 'ONLY_FORWARDER');

    (address registry, uint256 intentId, uint8 action, bytes32 receiptHash) = abi.decode(
      report,
      (address, uint256, uint8, bytes32)
    );

    if (registryAllowlistEnabled) {
      require(allowedRegistry[registry], 'REGISTRY_NOT_ALLOWED');
    }

    IIntentRegistry.Intent memory it = IIntentRegistry(registry).getIntent(intentId);

    if (it.status == uint8(Status.NONE)) {
      return;
    }

    if (it.status >= uint8(Status.EXECUTED)) {
      return;
    }

    if (it.status == uint8(Status.SUBMITTED)) {
      try IIntentRegistry(registry).markProcessing(intentId) {
      } catch {
      }
    }

    if (it.deadline <= block.timestamp) {
      IIntentRegistry(registry).finalize(intentId, uint8(Status.EXPIRED), bytes32(0), bytes32(0));
      return;
    }

    if (action != 0) {
      IIntentRegistry(registry).finalize(intentId, uint8(Status.REJECTED), receiptHash, bytes32(0));
      return;
    }

    if (it.mode == uint8(Mode.PROPOSE_ONLY)) {
      IIntentRegistry(registry).finalize(intentId, uint8(Status.EXECUTED), receiptHash, bytes32(0));
      return;
    }

    try IWalletGuardVault(it.vault).execute(it.to, it.value, it.data, receiptHash) {
      IIntentRegistry(registry).finalize(intentId, uint8(Status.EXECUTED), receiptHash, bytes32(0));
    } catch {
      IIntentRegistry(registry).finalize(intentId, uint8(Status.ERROR), receiptHash, bytes32(0));
    }
  }
}
