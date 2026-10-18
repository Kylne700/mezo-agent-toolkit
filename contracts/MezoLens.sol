// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITroveManager {
    function MCR() external view returns (uint256);
    function CCR() external view returns (uint256);
    function MUSD_GAS_COMPENSATION() external view returns (uint256);
    function getTroveStatus(address borrower) external view returns (uint8);
    function getEntireDebtAndColl(address borrower)
        external
        view
        returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest);
    function getTCR(uint256 price) external view returns (uint256);
    function getEntireSystemColl() external view returns (uint256);
    function getEntireSystemDebt() external view returns (uint256);
    function checkRecoveryMode(uint256 price) external view returns (bool);
}

interface ISortedTroves {
    function getLast() external view returns (address);
    function getPrev(address id) external view returns (address);
    function getSize() external view returns (uint256);
    function contains(address id) external view returns (bool);
}

interface IPriceFeed {
    function fetchPrice() external view returns (uint256);
}

interface IPoolRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function defaultFactory() external view returns (address);
    function poolFor(address tokenA, address tokenB, bool stable, address factory) external view returns (address);
    function getReserves(address tokenA, address tokenB, bool stable, address factory) external view returns (uint256 reserveA, uint256 reserveB);
    function getAmountsOut(uint256 amountIn, Route[] calldata routes) external view returns (uint256[] memory amounts);
}

interface IVeBTC {
    struct LockedBalance {
        int128 amount;
        uint256 end;
        bool isPermanent;
    }

    function balanceOf(address owner) external view returns (uint256);
    function ownerToNFTokenIdList(address owner, uint256 index) external view returns (uint256);
    function locked(uint256 tokenId) external view returns (LockedBalance memory);
    function balanceOfNFT(uint256 tokenId) external view returns (uint256);
    function voted(uint256 tokenId) external view returns (bool);
}

interface IVeMEZO {
    struct LockedBalance {
        int128 amount;
        uint256 end;
        bool isPermanent;
        uint256 boost;
    }

    function balanceOf(address owner) external view returns (uint256);
    function ownerToNFTokenIdList(address owner, uint256 index) external view returns (uint256);
    function locked(uint256 tokenId) external view returns (LockedBalance memory);
    function votingPowerOfNFT(uint256 tokenId) external view returns (uint256);
    function voted(uint256 tokenId) external view returns (bool);
}

/// @title MezoLens
/// @notice One eth_call answers what would take dozens of reads on Mezo: MUSD trove health, the redemption queue, DEX quotes and veBTC/veMEZO locks.
/// @dev Stateless: no owner, no storage, no payable function, nothing to upgrade. Every function is `view`.
/// Loops are bounded by a caller cap that is also clamped here, and long walks are paged with a cursor, so a call cannot run unbounded.
/// Amounts are 18-decimal fixed point. Ratios are 1e18 = 100%. Prices are USD per BTC with 18 decimals.
contract MezoLens {
    ITroveManager public immutable troveManager;
    ISortedTroves public immutable sortedTroves;
    IPriceFeed public immutable priceFeed;
    IPoolRouter public immutable router;
    IVeBTC public immutable veBTC;
    IVeMEZO public immutable veMEZO;

    uint256 public constant MAX_WALK = 300;
    uint256 public constant MAX_LOCKS = 100;
    uint256 private constant BPS = 10_000;

    struct TroveHealth {
        uint8 status; // 0 none, 1 active, 2 closed by owner, 3 closed by liquidation, 4 closed by redemption. The rest is 0 unless active.
        uint256 coll; // BTC collateral, including pending redistribution
        uint256 principal; // MUSD principal, including the gas reserve
        uint256 interest; // MUSD interest owed, accrued to this block
        uint256 debt; // principal + interest
        uint256 price; // USD per BTC from the protocol price feed
        uint256 icr; // coll * price / debt
        uint256 mcr; // minimum collateral ratio (a trove below it can be liquidated)
        uint256 liquidationPrice; // BTC price at which icr falls to mcr
        uint256 priceDropToLiquidationBps; // how far the price can fall before that, in basis points of the current price
    }

    struct SystemSnapshot {
        uint256 price;
        uint256 tcr;
        uint256 mcr;
        uint256 ccr;
        bool recoveryMode;
        bool redemptionsOpen; // redemptions revert while tcr < mcr
        uint256 troveCount;
        uint256 totalColl;
        uint256 totalDebt;
        address lowestNicr; // tail of the sorted list: where a redemption starts
        address firstRedeemable; // first trove from the tail with icr >= mcr (zero if none within the cap)
        uint256 firstRedeemableIcr;
        uint256 skippedBelowMcr; // troves from the tail skipped for icr < mcr
        bool scanTruncated; // the cap ran out before a redeemable trove was found
    }

    struct RedemptionQueue {
        bool listed; // the borrower has an open trove in the sorted list
        bool found; // the walk reached the borrower
        bool truncated; // the cap ran out first: call again with cursor = next
        address next; // where to continue, zero when the walk is over
        uint256 steps; // list nodes visited in this call
        uint256 ahead; // redeemable troves in front of the borrower seen in this call
        uint256 debtAhead; // MUSD a redemption must consume before it reaches the borrower: their debt minus the gas reserve
        uint256 belowMcr; // nodes seen with icr < mcr (a redemption skips them)
        uint256 borrowerIcr; // set when found. Below mcr means redemption skips the borrower too (liquidation risk instead).
        uint256 listSize;
        uint256 price;
        uint256 mcr;
    }

    struct PoolQuote {
        bool poolExists;
        bool quoteOk;
        address pool;
        address factory;
        uint256 amountOut;
        uint256 reserveIn;
        uint256 reserveOut;
        uint256 impactBps; // shortfall against the rate of a trade 1% of this size, in basis points (curve slippage beyond the fee)
    }

    struct Lock {
        address escrow; // veBTC or veMEZO
        uint256 tokenId;
        uint256 amount; // locked tokens
        uint256 end; // unlock time (unix seconds), meaningless when isPermanent
        bool isPermanent;
        uint256 votingPower;
        bool voted;
        uint256 secondsLeft; // 0 when permanent or expired
        bool expired;
    }

    constructor(address troveManager_, address sortedTroves_, address priceFeed_, address router_, address veBTC_, address veMEZO_) {
        require(
            troveManager_ != address(0) && sortedTroves_ != address(0) && priceFeed_ != address(0) && router_ != address(0)
                && veBTC_ != address(0) && veMEZO_ != address(0),
            "zero address"
        );
        troveManager = ITroveManager(troveManager_);
        sortedTroves = ISortedTroves(sortedTroves_);
        priceFeed = IPriceFeed(priceFeed_);
        router = IPoolRouter(router_);
        veBTC = IVeBTC(veBTC_);
        veMEZO = IVeMEZO(veMEZO_);
    }

    /// @notice Health of one MUSD trove: debt, collateral ratio, and the BTC price that would make it liquidatable.
    function troveHealth(address borrower) external view returns (TroveHealth memory h) {
        h.price = priceFeed.fetchPrice();
        h.mcr = troveManager.MCR();
        h.status = troveManager.getTroveStatus(borrower);
        if (h.status != 1) return h;
        (h.coll, h.principal, h.interest,,,) = troveManager.getEntireDebtAndColl(borrower);
        h.debt = h.principal + h.interest;
        h.icr = _cr(h.coll, h.debt, h.price);
        if (h.coll > 0) {
            h.liquidationPrice = (h.mcr * h.debt) / h.coll;
            if (h.price > h.liquidationPrice) h.priceDropToLiquidationBps = ((h.price - h.liquidationPrice) * BPS) / h.price;
        }
    }

    /// @notice Protocol-wide numbers plus the first trove a redemption would hit (scans at most maxSteps nodes from the tail, clamped to 1..MAX_WALK).
    function systemSnapshot(uint256 maxSteps) external view returns (SystemSnapshot memory s) {
        s.price = priceFeed.fetchPrice();
        s.mcr = troveManager.MCR();
        s.ccr = troveManager.CCR();
        s.tcr = troveManager.getTCR(s.price);
        s.recoveryMode = troveManager.checkRecoveryMode(s.price);
        s.redemptionsOpen = s.tcr >= s.mcr;
        s.troveCount = sortedTroves.getSize();
        s.totalColl = troveManager.getEntireSystemColl();
        s.totalDebt = troveManager.getEntireSystemDebt();

        address node = sortedTroves.getLast();
        s.lowestNicr = node;
        uint256 cap = _clamp(maxSteps, MAX_WALK);
        uint256 steps;
        while (node != address(0)) {
            if (steps == cap) {
                s.scanTruncated = true;
                break;
            }
            steps++;
            (uint256 icr,) = _icr(node, s.price);
            if (icr >= s.mcr) {
                s.firstRedeemable = node;
                s.firstRedeemableIcr = icr;
                break;
            }
            s.skippedBelowMcr++;
            node = sortedTroves.getPrev(node);
        }
    }

    /// @notice How much redemption demand stands between a redemption and this borrower's trove. A redemption walks the sorted list from the tail
    /// (lowest nominal ratio) toward the head and skips troves below MCR. Walk at most maxSteps nodes (clamped to 1..MAX_WALK) starting at cursor
    /// (zero starts at the tail); when `truncated` is true, call again with cursor = `next` and add up the counters.
    function redemptionQueue(address borrower, address cursor, uint256 maxSteps) external view returns (RedemptionQueue memory r) {
        r.price = priceFeed.fetchPrice();
        r.mcr = troveManager.MCR();
        r.listSize = sortedTroves.getSize();
        r.listed = sortedTroves.contains(borrower);
        if (!r.listed) return r;
        require(cursor == address(0) || sortedTroves.contains(cursor), "cursor not in list");

        uint256 gasReserve = troveManager.MUSD_GAS_COMPENSATION();
        uint256 cap = _clamp(maxSteps, MAX_WALK);
        address node = cursor == address(0) ? sortedTroves.getLast() : cursor;
        while (node != address(0)) {
            if (r.steps == cap) {
                r.truncated = true;
                r.next = node;
                return r;
            }
            r.steps++;
            (uint256 icr, uint256 debt) = _icr(node, r.price);
            if (node == borrower) {
                r.found = true;
                r.borrowerIcr = icr;
                return r;
            }
            if (icr < r.mcr) {
                r.belowMcr++;
            } else {
                r.ahead++;
                if (debt > gasReserve) r.debtAhead += debt - gasReserve;
            }
            node = sortedTroves.getPrev(node);
        }
    }

    /// @notice Quote a swap on the Mezo DEX router without executing it. Never reverts for a missing pool or a router error: check poolExists and quoteOk.
    function poolQuote(address tokenIn, address tokenOut, uint256 amountIn, bool stable) external view returns (PoolQuote memory q) {
        q.factory = router.defaultFactory();
        try router.poolFor(tokenIn, tokenOut, stable, q.factory) returns (address p) {
            q.pool = p;
        } catch {
            return q;
        }
        if (q.pool.code.length == 0) return q;
        q.poolExists = true;
        try router.getReserves(tokenIn, tokenOut, stable, q.factory) returns (uint256 reserveIn, uint256 reserveOut) {
            q.reserveIn = reserveIn;
            q.reserveOut = reserveOut;
        } catch {}

        IPoolRouter.Route[] memory routes = new IPoolRouter.Route[](1);
        routes[0] = IPoolRouter.Route(tokenIn, tokenOut, stable, q.factory);
        try router.getAmountsOut(amountIn, routes) returns (uint256[] memory amounts) {
            if (amounts.length != 2) return q;
            q.amountOut = amounts[1];
            q.quoteOk = true;
        } catch {
            return q;
        }

        uint256 probe = amountIn / 100;
        if (probe > 0 && q.amountOut > 0) {
            try router.getAmountsOut(probe, routes) returns (uint256[] memory small) {
                if (small.length == 2) {
                    uint256 ideal = small[1] * 100;
                    if (ideal > q.amountOut) q.impactBps = ((ideal - q.amountOut) * BPS) / ideal;
                }
            } catch {}
        }
    }

    /// @notice veBTC locks first, then veMEZO locks, of one owner, at most max entries (clamped to 1..MAX_LOCKS).
    /// The counts are the owner's full holdings: if their sum exceeds locks.length, the list was cut.
    function veLocks(address owner, uint256 max) external view returns (Lock[] memory locks, uint256 veBtcCount, uint256 veMezoCount) {
        veBtcCount = veBTC.balanceOf(owner);
        veMezoCount = veMEZO.balanceOf(owner);
        uint256 total = veBtcCount + veMezoCount;
        uint256 cap = _clamp(max, MAX_LOCKS);
        uint256 n = total < cap ? total : cap;
        locks = new Lock[](n);
        for (uint256 i = 0; i < n; i++) {
            locks[i] = i < veBtcCount ? _btcLock(owner, i) : _mezoLock(owner, i - veBtcCount);
        }
    }

    function _btcLock(address owner, uint256 index) private view returns (Lock memory k) {
        k.tokenId = veBTC.ownerToNFTokenIdList(owner, index);
        IVeBTC.LockedBalance memory l = veBTC.locked(k.tokenId);
        k.escrow = address(veBTC);
        k.amount = l.amount > 0 ? uint256(uint128(l.amount)) : 0;
        k.end = l.end;
        k.isPermanent = l.isPermanent;
        k.votingPower = veBTC.balanceOfNFT(k.tokenId);
        k.voted = veBTC.voted(k.tokenId);
        _timing(k);
    }

    function _mezoLock(address owner, uint256 index) private view returns (Lock memory k) {
        k.tokenId = veMEZO.ownerToNFTokenIdList(owner, index);
        IVeMEZO.LockedBalance memory l = veMEZO.locked(k.tokenId);
        k.escrow = address(veMEZO);
        k.amount = l.amount > 0 ? uint256(uint128(l.amount)) : 0;
        k.end = l.end;
        k.isPermanent = l.isPermanent;
        k.votingPower = veMEZO.votingPowerOfNFT(k.tokenId);
        k.voted = veMEZO.voted(k.tokenId);
        _timing(k);
    }

    function _timing(Lock memory k) private view {
        k.expired = !k.isPermanent && k.end <= block.timestamp;
        k.secondsLeft = (k.isPermanent || k.expired) ? 0 : k.end - block.timestamp;
    }

    /// Same arithmetic as the protocol: coll * price / debt, and "infinite" for zero debt.
    function _cr(uint256 coll, uint256 debt, uint256 price) private pure returns (uint256) {
        return debt == 0 ? type(uint256).max : (coll * price) / debt;
    }

    /// Collateral ratio and total debt (principal + interest, pending redistribution included) of a trove.
    function _icr(address borrower, uint256 price) private view returns (uint256 icr, uint256 debt) {
        (uint256 coll, uint256 principal, uint256 interest,,,) = troveManager.getEntireDebtAndColl(borrower);
        debt = principal + interest;
        icr = _cr(coll, debt, price);
    }

    function _clamp(uint256 requested, uint256 max) private pure returns (uint256) {
        if (requested == 0) return 1;
        return requested > max ? max : requested;
    }
}
