pragma solidity ^0.8.20;

contract IntentRegistry {
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

  struct Intent {
    address creator;
    address vault;
    address to;
    uint256 value;
    bytes data;
    uint256 deadline;
    Mode mode;
    Status status;
    bytes32 receiptHash;
    bytes32 executorTxHash;
  }

  event IntentSubmitted(
    uint256 indexed intentId,
    address indexed creator,
    address indexed vault,
    address to,
    uint256 value,
    uint256 deadline,
    uint8 mode
  );

  event IntentProcessing(uint256 indexed intentId, address indexed executor);

  event IntentFinalized(
    uint256 indexed intentId,
    uint8 status,
    bytes32 receiptHash,
    bytes32 executorTxHash
  );

  address public owner;
  address public executor;

  bool public vaultAllowlistEnabled;
  mapping(address => bool) public allowedVault;

  uint256 public nextIntentId;
  mapping(uint256 => Intent) private intents;

  modifier onlyOwner() {
    require(msg.sender == owner, 'ONLY_OWNER');
    _;
  }

  modifier onlyExecutor() {
    require(msg.sender == executor, 'ONLY_EXECUTOR');
    _;
  }

  constructor(address owner_, address executor_) {
    require(owner_ != address(0), 'OWNER_ZERO');
    require(executor_ != address(0), 'EXECUTOR_ZERO');
    owner = owner_;
    executor = executor_;
    nextIntentId = 1;
  }

  function setOwner(address owner_) external onlyOwner {
    require(owner_ != address(0), 'OWNER_ZERO');
    owner = owner_;
  }

  function setExecutor(address executor_) external onlyOwner {
    require(executor_ != address(0), 'EXECUTOR_ZERO');
    executor = executor_;
  }

  function setVaultAllowlistEnabled(bool enabled) external onlyOwner {
    vaultAllowlistEnabled = enabled;
  }

  function setAllowedVault(address vault, bool allowed) external onlyOwner {
    allowedVault[vault] = allowed;
  }

  function submitIntent(
    address vault,
    address to,
    uint256 value,
    bytes calldata data,
    uint256 deadline,
    uint8 mode
  ) external returns (uint256) {
    require(vault != address(0), 'VAULT_ZERO');
    require(to != address(0), 'TO_ZERO');
    require(deadline > block.timestamp, 'DEADLINE');

    if (vaultAllowlistEnabled) {
      require(allowedVault[vault], 'VAULT_NOT_ALLOWED');
    }

    uint256 intentId = nextIntentId;
    nextIntentId = intentId + 1;

    Mode m = mode == uint8(Mode.PROPOSE_ONLY) ? Mode.PROPOSE_ONLY : Mode.AUTO_EXECUTE;

    intents[intentId] = Intent({
      creator: msg.sender,
      vault: vault,
      to: to,
      value: value,
      data: data,
      deadline: deadline,
      mode: m,
      status: Status.SUBMITTED,
      receiptHash: bytes32(0),
      executorTxHash: bytes32(0)
    });

    emit IntentSubmitted(intentId, msg.sender, vault, to, value, deadline, uint8(m));
    return intentId;
  }

  function markProcessing(uint256 intentId) external onlyExecutor {
    Intent storage it = intents[intentId];
    require(it.status == Status.SUBMITTED, 'NOT_SUBMITTED');
    it.status = Status.PROCESSING;
    emit IntentProcessing(intentId, msg.sender);
  }

  function finalize(
    uint256 intentId,
    uint8 status,
    bytes32 receiptHash,
    bytes32 executorTxHash
  ) external onlyExecutor {
    Intent storage it = intents[intentId];
    require(it.status == Status.SUBMITTED || it.status == Status.PROCESSING, 'NOT_ACTIVE');

    Status s = Status(status);
    require(
      s == Status.EXECUTED || s == Status.REJECTED || s == Status.EXPIRED || s == Status.ERROR,
      'BAD_STATUS'
    );

    it.status = s;
    it.receiptHash = receiptHash;
    it.executorTxHash = executorTxHash;

    emit IntentFinalized(intentId, uint8(s), receiptHash, executorTxHash);
  }

  function getIntent(uint256 intentId) external view returns (Intent memory) {
    return intents[intentId];
  }
}
