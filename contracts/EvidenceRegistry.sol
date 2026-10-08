// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EvidenceRegistry
/// @notice Stores only SHA-256 fingerprints, never the PDF itself.
contract EvidenceRegistry {
    struct Evidence {
        address registeredBy;
        uint256 registeredAt;
        bool exists;
    }

    mapping(bytes32 => Evidence) private evidence;

    event EvidenceRegistered(
        bytes32 indexed documentHash,
        address indexed registeredBy,
        uint256 registeredAt
    );

    error InvalidHash();
    error EvidenceAlreadyRegistered(bytes32 documentHash);

    function registerEvidence(bytes32 documentHash) external {
        if (documentHash == bytes32(0)) revert InvalidHash();
        if (evidence[documentHash].exists) {
            revert EvidenceAlreadyRegistered(documentHash);
        }

        evidence[documentHash] = Evidence({
            registeredBy: msg.sender,
            registeredAt: block.timestamp,
            exists: true
        });

        emit EvidenceRegistered(documentHash, msg.sender, block.timestamp);
    }

    function getEvidence(bytes32 documentHash)
        external
        view
        returns (address registeredBy, uint256 registeredAt, bool exists)
    {
        Evidence memory item = evidence[documentHash];
        return (item.registeredBy, item.registeredAt, item.exists);
    }
}
