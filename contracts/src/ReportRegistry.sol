pragma solidity ^0.8.20;

contract ReportRegistry {
  event ReportCommitted(
    bytes32 indexed reportHash,
    address indexed requester,
    uint256 indexed chainId,
    uint256 timestamp,
    string uri
  );

  mapping(bytes32 => bool) public committed;

  function commitReport(bytes32 reportHash, uint256 chainId, string calldata uri) external {
    committed[reportHash] = true;
    emit ReportCommitted(reportHash, msg.sender, chainId, block.timestamp, uri);
  }
}
