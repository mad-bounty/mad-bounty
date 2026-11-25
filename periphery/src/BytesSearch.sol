// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Naive substring search over bytes. O(n*m); intended for short needles (<= ~100 bytes) and
///         haystacks of a few KB.
library BytesSearch {
    uint256 internal constant NOT_FOUND = type(uint256).max;

    /// @return idx first index >= from where `needle` occurs in `hay`, or NOT_FOUND. Empty needle → `from`
    ///         if from <= hay.length.
    function indexOf(bytes memory hay, bytes memory needle, uint256 from) internal pure returns (uint256 idx) {
        uint256 n = hay.length;
        uint256 m = needle.length;
        if (m == 0) return from <= n ? from : NOT_FOUND;
        if (m > n || from > n - m) return NOT_FOUND;
        bytes1 first = needle[0];
        uint256 last = n - m;
        for (uint256 i = from; i <= last; ++i) {
            if (hay[i] != first) continue;
            bool ok = true;
            for (uint256 j = 1; j < m; ++j) {
                if (hay[i + j] != needle[j]) { ok = false; break; }
            }
            if (ok) return i;
        }
        return NOT_FOUND;
    }

    function contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        return indexOf(hay, needle, 0) != NOT_FOUND;
    }
}
