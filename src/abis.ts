// Minimal hand-written ABIs (read from the verified contracts on the Mezo testnet explorer). No vendor packages.
import { parseAbi } from 'viem'

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

// Solidly/Velodrome-style router used by Mezo (poolRouter). A route is (from, to, stable, factory).
export const routerAbi = parseAbi([
  'function defaultFactory() view returns (address)',
  'function poolFor(address tokenA, address tokenB, bool stable, address factory) view returns (address)',
  'function getReserves(address tokenA, address tokenB, bool stable, address factory) view returns (uint256 reserveA, uint256 reserveB)',
  'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
])

// Direct-read ABIs for the protocol contracts the lens wraps. The smoke and MCP session scripts read these without the lens and compare.
export const troveManagerAbi = parseAbi([
  'function MCR() view returns (uint256)',
  'function CCR() view returns (uint256)',
  'function MUSD_GAS_COMPENSATION() view returns (uint256)',
  'function getTroveStatus(address borrower) view returns (uint8)',
  'function getEntireDebtAndColl(address borrower) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)',
  'function getTCR(uint256 price) view returns (uint256)',
  'function getEntireSystemColl() view returns (uint256)',
  'function getEntireSystemDebt() view returns (uint256)',
  'function checkRecoveryMode(uint256 price) view returns (bool)',
  // What the trove planner and its tests read directly.
  'function getCurrentICR(address borrower, uint256 price) view returns (uint256)',
  'function getTroveMaxBorrowingCapacity(address borrower) view returns (uint256)',
  'function getTroveOwnersCount() view returns (uint256)',
  // Anyone may liquidate a trove under the minimum ratio; the caller earns the gas compensation (200 MUSD and 0.5% of the collateral).
  'function liquidate(address borrower)',
  'event TroveLiquidated(address indexed borrower, uint256 debt, uint256 coll, uint8 operation)',
  'event Liquidation(uint256 liquidatedPrincipal, uint256 liquidatedInterest, uint256 liquidatedColl, uint256 collGasCompensation, uint256 gasCompensation)',
  'function Troves(address borrower) view returns (uint256 coll, uint256 principal, uint256 interestOwed, uint256 stake, uint8 status, uint16 interestRate, uint256 lastInterestUpdateTime, uint256 maxBorrowingCapacity, uint128 arrayIndex)',
])

export const sortedTrovesAbi = parseAbi([
  'function getFirst() view returns (address)',
  'function getLast() view returns (address)',
  'function getPrev(address id) view returns (address)',
  'function getSize() view returns (uint256)',
  'function contains(address id) view returns (bool)',
  'function getNext(address id) view returns (address)',
  'function findInsertPosition(uint256 nicr, address prevId, address nextId) view returns (address, address)',
])

export const priceFeedAbi = parseAbi(['function fetchPrice() view returns (uint256)'])

export const hintHelpersAbi = parseAbi([
  'function getRedemptionHints(uint256 _amount, uint256 _price, uint256 _maxIterations) view returns (address firstRedemptionHint, uint256 partialRedemptionHintNICR, uint256 truncatedAmount)',
  'function getApproxHint(uint256 _CR, uint256 _numTrials, uint256 _inputRandomSeed) view returns (address hintAddress, uint256 diff, uint256 latestRandomSeed)',
])

// BorrowerOperations, the trove entry points (read from the verified source). The hints are the neighbours in SortedTroves, higher ratio first.
export const borrowerOperationsAbi = parseAbi([
  'function openTrove(uint256 _debtAmount, address _upperHint, address _lowerHint) payable',
  'function addColl(address _upperHint, address _lowerHint) payable',
  'function repayMUSD(uint256 _amount, address _upperHint, address _lowerHint)',
  'function minNetDebt() view returns (uint256)',
  'function borrowingRate() view returns (uint256)',
  'function governableVariables() view returns (address)',
])
export const governableVariablesAbi = parseAbi(['function isAccountFeeExempt(address account) view returns (bool)'])

// veBTC and veMEZO are Solidly-style vote escrows. The LIVE veBTC has no balanceOfNFT and returns a fourth lock field (boost), which this ABI does not decode.
// The last four entries are what the write tools use (createLock pulls BTC through the ERC-20 interface, so it needs an exact approve first).
export const veBtcAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerToNFTokenIdList(address owner, uint256 index) view returns (uint256)',
  'function locked(uint256 tokenId) view returns ((int128 amount, uint256 end, bool isPermanent))',
  'function votingPowerOfNFT(uint256 tokenId) view returns (uint256)',
  'function voted(uint256 tokenId) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isApprovedOrOwner(address spender, uint256 tokenId) view returns (bool)',
  'function createLock(uint256 value, uint256 lockDuration) returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
])

export const veMezoAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerToNFTokenIdList(address owner, uint256 index) view returns (uint256)',
  'function locked(uint256 tokenId) view returns ((int128 amount, uint256 end, bool isPermanent, uint256 boost))',
  'function votingPowerOfNFT(uint256 tokenId) view returns (uint256)',
  'function voted(uint256 tokenId) view returns (bool)',
])

// The LIVE poolsVoter (read from its verified source). A vote stays in force until the NFT votes again or is reset; rewards pay completed epochs.
export const poolsVoterAbi = parseAbi([
  'function length() view returns (uint256)',
  'function pools(uint256 index) view returns (address)',
  'function gauges(address pool) view returns (address)',
  'function gaugeToFees(address gauge) view returns (address)',
  'function gaugeToBribe(address gauge) view returns (address)',
  'function isAlive(address gauge) view returns (bool)',
  'function weights(address pool) view returns (uint256)',
  'function totalWeight() view returns (uint256)',
  'function votes(uint256 tokenId, address pool) view returns (uint256)',
  'function lastVoted(uint256 tokenId) view returns (uint256)',
  'function usedWeights(uint256 tokenId) view returns (uint256)',
  'function maxVotingNum() view returns (uint256)',
  'function isWhitelistedNFT(uint256 tokenId) view returns (bool)',
  'function vote(uint256 tokenId, address[] poolVote, uint256[] weights)',
  'function poke(uint256 tokenId)',
  'function claimFeesAndBribes(address[] rewards, address[][] tokens, uint256 tokenId)',
])

// RewardsDistributor (the veBTC rebase). activePeriod() lives on its depositor, which tells whether a ve system still distributes.
export const rewardsDistributorAbi = parseAbi([
  'function depositor() view returns (address)',
  'function claimable(uint256 tokenId) view returns (uint256)',
  'function claim(uint256 tokenId) returns (uint256)',
])
export const depositorAbi = parseAbi(['function activePeriod() view returns (uint256)'])

// A gauge's fee reward and bribe reward contracts (gaugeToFees, gaugeToBribe). They are not verified on the explorer; these calls were checked against the live contracts.
export const rewardAbi = parseAbi([
  'function rewardsListLength() view returns (uint256)',
  'function rewards(uint256 index) view returns (address)',
  'function tokenRewardsPerEpoch(address token, uint256 epochStart) view returns (uint256)',
  'function earned(address token, uint256 tokenId) view returns (uint256)',
])

export const poolNameAbi = parseAbi(['function name() view returns (string)'])

// The Stability Pool (read from the verified implementation behind the proxy). A deposit is MUSD that absorbs liquidated debt and earns the liquidated BTC.
export const stabilityPoolAbi = parseAbi([
  'function provideToSP(uint256 _amount)',
  'function withdrawFromSP(uint256 _amount)',
  'function deposits(address) view returns (uint256)',
  'function getCompoundedMUSDDeposit(address) view returns (uint256)',
  'function getDepositorCollateralGain(address) view returns (uint256)',
  'function getTotalMUSDDeposits() view returns (uint256)',
  'function getCollateralBalance() view returns (uint256)',
  'function MCR() view returns (uint256)',
  // The contracts the pool itself asks before it lets a withdrawal through.
  'function sortedTroves() view returns (address)',
  'function priceFeed() view returns (address)',
  'function troveManager() view returns (address)',
])
