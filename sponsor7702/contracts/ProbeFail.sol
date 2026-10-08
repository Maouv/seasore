// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ProbeFail {
    function boom() external pure {
        revert("MINT_NOT_OPEN");
    }
}