// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Test doubles for the Mezo contracts the lens reads. They mirror the function names and return layouts of the real contracts
// (checked against the verified sources on the explorer) and hold whatever state a test sets. Never deployed anywhere.

contract MockTroveManager {
    uint256 public constant MCR = 1.1e18;
    uint256 public constant CCR = 1.5e18;
    uint256 public constant MUSD_GAS_COMPENSATION = 200e18;

    struct T {
        uint256 coll;
        uint256 principal;
        uint256 interest;
        uint8 status;
    }

    mapping(address => T) public troves;
    uint256 public systemColl;
    uint256 public systemDebt;

    function setTrove(address b, uint256 coll, uint256 principal, uint256 interest, uint8 status) external {
        troves[b] = T(coll, principal, interest, status);
    }

    function setSystem(uint256 coll, uint256 debt) external {
        systemColl = coll;
        systemDebt = debt;
    }

    function getTroveStatus(address b) external view returns (uint8) {
        return troves[b].status;
    }

    function getEntireDebtAndColl(address b) external view returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        T memory t = troves[b];
        return (t.coll, t.principal, t.interest, 0, 0, 0);
    }

    function getTCR(uint256 price) public view returns (uint256) {
        return systemDebt == 0 ? type(uint256).max : (systemColl * price) / systemDebt;
    }

    function getEntireSystemColl() external view returns (uint256) {
        return systemColl;
    }

    function getEntireSystemDebt() external view returns (uint256) {
        return systemDebt;
    }

    function checkRecoveryMode(uint256 price) external view returns (bool) {
        return getTCR(price) < CCR;
    }
}

/// Index 0 is the head (highest nominal ratio) and the last element is the tail (lowest), like the real SortedTroves.
contract MockSortedTroves {
    address[] public order;

    function push(address a) external {
        order.push(a);
    }

    function getLast() external view returns (address) {
        return order.length == 0 ? address(0) : order[order.length - 1];
    }

    function getPrev(address id) external view returns (address) {
        for (uint256 i = 0; i < order.length; i++) {
            if (order[i] == id) return i == 0 ? address(0) : order[i - 1];
        }
        return address(0);
    }

    function getSize() external view returns (uint256) {
        return order.length;
    }

    function contains(address id) external view returns (bool) {
        for (uint256 i = 0; i < order.length; i++) {
            if (order[i] == id) return true;
        }
        return false;
    }
}

contract MockPriceFeed {
    uint256 public price;

    function set(uint256 p) external {
        price = p;
    }

    function fetchPrice() external view returns (uint256) {
        return price;
    }
}

contract MockPool {}

contract MockRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    struct Pool {
        address pool;
        uint256 reserveA;
        uint256 reserveB;
        bool exists;
    }

    address public constant defaultFactory = address(0xFAc7);
    mapping(bytes32 => Pool) private pools;

    function _key(address a, address b, bool stable) private pure returns (bytes32) {
        return keccak256(abi.encode(a, b, stable));
    }

    function addPool(address a, address b, bool stable, uint256 reserveA, uint256 reserveB) external {
        address p = address(new MockPool());
        pools[_key(a, b, stable)] = Pool(p, reserveA, reserveB, true);
        pools[_key(b, a, stable)] = Pool(p, reserveB, reserveA, true);
    }

    function poolFor(address a, address b, bool stable, address factory) external view returns (address) {
        Pool memory p = pools[_key(a, b, stable)];
        // A missing pool still has a computed address, like the real router, but nothing is deployed there.
        return p.exists ? p.pool : address(uint160(uint256(keccak256(abi.encode(a, b, stable, factory)))));
    }

    function getReserves(address a, address b, bool stable, address) external view returns (uint256, uint256) {
        Pool memory p = pools[_key(a, b, stable)];
        require(p.exists, "no pool");
        return (p.reserveA, p.reserveB);
    }

    /// Constant product with a 0.3% fee.
    function getAmountsOut(uint256 amountIn, Route[] calldata routes) external view returns (uint256[] memory amounts) {
        require(routes.length == 1, "one hop only");
        Pool memory p = pools[_key(routes[0].from, routes[0].to, routes[0].stable)];
        require(p.exists, "no pool");
        require(amountIn > 0, "zero in");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = (amountIn * 997 * p.reserveB) / (p.reserveA * 1000 + amountIn * 997);
    }
}

contract MockVeBTC {
    struct LockedBalance {
        int128 amount;
        uint256 end;
        bool isPermanent;
    }

    mapping(address => uint256[]) private ids;
    mapping(uint256 => LockedBalance) private lockOf;
    mapping(uint256 => uint256) private power;
    mapping(uint256 => bool) public voted;

    function add(address owner, uint256 id, int128 amount, uint256 end, bool perm, uint256 vp, bool hasVoted) external {
        ids[owner].push(id);
        lockOf[id] = LockedBalance(amount, end, perm);
        power[id] = vp;
        voted[id] = hasVoted;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return ids[owner].length;
    }

    function ownerToNFTokenIdList(address owner, uint256 i) external view returns (uint256) {
        return ids[owner][i];
    }

    function locked(uint256 id) external view returns (LockedBalance memory) {
        return lockOf[id];
    }

    function balanceOfNFT(uint256 id) external view returns (uint256) {
        return power[id];
    }
}

contract MockVeMEZO {
    struct LockedBalance {
        int128 amount;
        uint256 end;
        bool isPermanent;
        uint256 boost;
    }

    mapping(address => uint256[]) private ids;
    mapping(uint256 => LockedBalance) private lockOf;
    mapping(uint256 => uint256) private power;
    mapping(uint256 => bool) public voted;

    function add(address owner, uint256 id, int128 amount, uint256 end, bool perm, uint256 vp, bool hasVoted) external {
        ids[owner].push(id);
        lockOf[id] = LockedBalance(amount, end, perm, 2e18);
        power[id] = vp;
        voted[id] = hasVoted;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return ids[owner].length;
    }

    function ownerToNFTokenIdList(address owner, uint256 i) external view returns (uint256) {
        return ids[owner][i];
    }

    function locked(uint256 id) external view returns (LockedBalance memory) {
        return lockOf[id];
    }

    function votingPowerOfNFT(uint256 id) external view returns (uint256) {
        return power[id];
    }
}
